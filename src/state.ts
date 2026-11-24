import {
  CatalogProduct,
  ProductItem,
  ProposalFailureItem,
  ProposalResultPayload,
  RoomStateSnapshot,
  ServerErrorCode,
} from './types.js';
import { CatalogConfig, fetchManyProductsConcurrently } from './catalog.js';

export type StateOperationResult<T = RoomStateSnapshot> =
  | { ok: true; value: T }
  | { ok: false; code: ServerErrorCode; message: string };

interface InternalProduct {
  id: number;
  title: string;
  price: number;
  thumbnail: string;
  proposedBy: string;
  proposedAt: string;
  votes: Set<string>;
}

/**
 * Representa una lista compartida en memoria (Sala / Room).
 * Maneja:
 * - Participantes conectados (con soporte para reconexión o múltiples pestañas de la misma sesión)
 * - Productos propuestos y sus votos
 * - Prevención de duplicados y condiciones de carrera cuando dos participantes proponen el mismo producto
 * - Regla para quitar productos: puede quitarlo quien lo propuso, o cualquier participante si tiene 0 votos
 */
export class GiftRoom {
  public readonly roomCode: string;
  private participants = new Map<string, number>(); // normalizedName -> displayName / active connection count
  private displayNames = new Map<string, string>(); // normalizedName -> displayName
  private products = new Map<number, InternalProduct>();
  private updatedAt: string = new Date().toISOString();

  constructor(roomCode = 'general') {
    this.roomCode = roomCode;
  }

  private normalizeName(name: string): string {
    return name.trim().toLowerCase();
  }

  /**
   * Registra el ingreso de un participante.
   * Por decisión de diseño: no se aceptan nombres repetidos simultáneamente en la misma sala,
   * salvo que se indique `allowTakeover = true` (usado cuando se reemplaza una conexión zombie).
   */
  public addParticipant(name: string): StateOperationResult<{ name: string; state: RoomStateSnapshot }> {
    const key = this.normalizeName(name);
    if (this.participants.has(key)) {
      return {
        ok: false,
        code: 'NAME_TAKEN',
        message: `Ya hay un participante conectado con el nombre "${this.displayNames.get(key) ?? name}". Elegí otro nombre.`,
      };
    }

    this.participants.set(key, 1);
    this.displayNames.set(key, name);
    this.touch();

    return {
      ok: true,
      value: {
        name,
        state: this.getSnapshot(),
      },
    };
  }

  /**
   * Elimina a un participante conectado cuando cierra la pestaña o se desconecta.
   */
  public removeParticipant(name: string): boolean {
    const key = this.normalizeName(name);
    if (!this.participants.has(key)) {
      return false;
    }
    this.participants.delete(key);
    this.displayNames.delete(key);
    this.touch();
    return true;
  }

  public hasParticipant(name: string): boolean {
    return this.participants.has(this.normalizeName(name));
  }

  /**
   * Procesa una propuesta de 1 a 10 IDs de productos en una sola acción:
   * - Si la propuesta repite el mismo ID varias veces en el mismo envío, el primero se procesa y los repetidos se informan como ALREADY_IN_LIST.
   * - Si un ID ya está en la lista antes de consultar al catálogo, se reporta inmediatamente como ALREADY_IN_LIST.
   * - Los demás IDs se consultan en simultáneo al catálogo externo.
   * - Al volver del catálogo (operación asíncrona), se vuelve a verificar si otro participante agregó el mismo producto mientras se esperaba (Consistencia sin duplicados).
   */
  public async proposeProducts(
    proposerName: string,
    productIds: number[],
    catalogConfig: CatalogConfig,
    fetchImpl: typeof fetch = fetch,
    requestId?: string
  ): Promise<{
    result: ProposalResultPayload;
    stateChanged: boolean;
    state: RoomStateSnapshot;
  }> {
    const added: ProductItem[] = [];
    const failed: ProposalFailureItem[] = [];
    const idsToFetch: number[] = [];
    const seenInBatch = new Set<number>();

    for (const id of productIds) {
      if (seenInBatch.has(id)) {
        failed.push({
          productId: id,
          reason: 'ALREADY_IN_LIST',
          message: `El producto #${id} fue incluido más de una vez en la misma propuesta.`,
        });
        continue;
      }
      seenInBatch.add(id);

      if (this.products.has(id)) {
        failed.push({
          productId: id,
          reason: 'ALREADY_IN_LIST',
          message: `El producto #${id} ("${this.products.get(id)!.title}") ya estaba en la lista.`,
        });
        continue;
      }

      idsToFetch.push(id);
    }

    if (idsToFetch.length > 0) {
      const outcomes = await fetchManyProductsConcurrently(idsToFetch, catalogConfig, fetchImpl);

      for (const outcome of outcomes) {
        if (!outcome.ok) {
          failed.push({
            productId: outcome.productId,
            reason: outcome.reason,
            message: outcome.message,
          });
          continue;
        }

        // Verificación atómica tras el await: ¿alguien más agregó este mismo producto mientras esperábamos al catálogo?
        if (this.products.has(outcome.product.id) || this.products.has(outcome.productId)) {
          const existing = this.products.get(outcome.product.id) ?? this.products.get(outcome.productId);
          failed.push({
            productId: outcome.productId,
            reason: 'ALREADY_IN_LIST',
            message: `El producto #${outcome.productId} ("${existing?.title ?? outcome.product.title}") ya fue agregado a la lista por otro participante.`,
          });
          continue;
        }

        const created = this.insertCatalogProduct(outcome.product, proposerName);
        added.push(created);
      }
    }

    if (added.length > 0) {
      this.touch();
    }

    return {
      result: {
        requestId,
        added,
        failed,
      },
      stateChanged: added.length > 0,
      state: this.getSnapshot(),
    };
  }

  private insertCatalogProduct(product: CatalogProduct, proposerName: string): ProductItem {
    const now = new Date().toISOString();
    const internal: InternalProduct = {
      id: product.id,
      title: product.title,
      price: product.price,
      thumbnail: product.thumbnail,
      proposedBy: proposerName,
      proposedAt: now,
      votes: new Set<string>(),
    };
    this.products.set(product.id, internal);
    return this.toProductItem(internal);
  }

  /**
   * Registra el voto de un participante sobre un producto.
   * Cada participante puede votar un producto una sola vez.
   */
  public voteProduct(voterName: string, productId: number): StateOperationResult {
    const product = this.products.get(productId);
    if (!product) {
      return {
        ok: false,
        code: 'PRODUCT_NOT_IN_LIST',
        message: `El producto #${productId} no se encuentra en la lista.`,
      };
    }

    const canonicalName = this.displayNames.get(this.normalizeName(voterName)) ?? voterName;
    const hasAlreadyVoted = Array.from(product.votes).some(
      (v) => this.normalizeName(v) === this.normalizeName(canonicalName)
    );

    if (hasAlreadyVoted) {
      return {
        ok: false,
        code: 'ALREADY_VOTED',
        message: `Ya votaste por el producto "${product.title}" (#${productId}).`,
      };
    }

    product.votes.add(canonicalName);
    this.touch();
    return { ok: true, value: this.getSnapshot() };
  }

  /**
   * Retira el voto de un participante sobre un producto.
   */
  public unvoteProduct(voterName: string, productId: number): StateOperationResult {
    const product = this.products.get(productId);
    if (!product) {
      return {
        ok: false,
        code: 'PRODUCT_NOT_IN_LIST',
        message: `El producto #${productId} no se encuentra en la lista.`,
      };
    }

    const matchingVote = Array.from(product.votes).find(
      (v) => this.normalizeName(v) === this.normalizeName(voterName)
    );

    if (!matchingVote) {
      return {
        ok: false,
        code: 'VOTE_NOT_FOUND',
        message: `No tenés un voto registrado en el producto "${product.title}" (#${productId}).`,
      };
    }

    product.votes.delete(matchingVote);
    this.touch();
    return { ok: true, value: this.getSnapshot() };
  }

  /**
   * Quita un producto de la lista según la regla definida en el servidor (Requisito 10):
   * - Puede quitarlo la persona que lo propuso (`proposedBy`), O
   * - Puede quitarlo cualquier participante si el producto no tiene votos (`votes.size === 0`).
   */
  public removeProduct(actorName: string, productId: number): StateOperationResult {
    const product = this.products.get(productId);
    if (!product) {
      return {
        ok: false,
        code: 'PRODUCT_NOT_IN_LIST',
        message: `El producto #${productId} no se encuentra en la lista.`,
      };
    }

    const isProposer = this.normalizeName(product.proposedBy) === this.normalizeName(actorName);
    const hasNoVotes = product.votes.size === 0;

    if (!isProposer && !hasNoVotes) {
      return {
        ok: false,
        code: 'FORBIDDEN_ACTION',
        message: `Solo quien propuso "${product.title}" (${product.proposedBy}) puede quitarlo cuando ya tiene votos.`,
      };
    }

    this.products.delete(productId);
    this.touch();
    return { ok: true, value: this.getSnapshot() };
  }

  /**
   * Devuelve el estado actual con la lista ordenada por cantidad de votos (descendente)
   * y desempate por orden de propuesta / ID para estabilidad visual.
   */
  public getSnapshot(): RoomStateSnapshot {
    const sortedProducts = Array.from(this.products.values())
      .map((p) => this.toProductItem(p))
      .sort((a, b) => {
        if (b.voteCount !== a.voteCount) {
          return b.voteCount - a.voteCount;
        }
        return a.proposedAt.localeCompare(b.proposedAt) || a.id - b.id;
      });

    const participantList = Array.from(this.displayNames.values());

    return {
      roomCode: this.roomCode,
      participants: participantList,
      participantCount: participantList.length,
      products: sortedProducts,
      updatedAt: this.updatedAt,
    };
  }

  private toProductItem(p: InternalProduct): ProductItem {
    const votes = Array.from(p.votes);
    return {
      id: p.id,
      title: p.title,
      price: p.price,
      thumbnail: p.thumbnail,
      proposedBy: p.proposedBy,
      proposedAt: p.proposedAt,
      votes,
      voteCount: votes.length,
    };
  }

  private touch(): void {
    this.updatedAt = new Date().toISOString();
  }
}

/**
 * Administra una o varias salas independientes en memoria (por defecto la sala "general").
 */
export class RoomManager {
  private rooms = new Map<string, GiftRoom>();

  public getOrCreateRoom(roomCode = 'general'): GiftRoom {
    const normalized = roomCode.trim().toLowerCase() || 'general';
    let room = this.rooms.get(normalized);
    if (!room) {
      room = new GiftRoom(normalized);
      this.rooms.set(normalized, room);
    }
    return room;
  }
}
