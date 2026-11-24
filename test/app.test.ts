import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAndValidateClientMessage,
  validateParticipantName,
} from '../src/validation.js';
import { GiftRoom } from '../src/state.js';
import { CatalogConfig } from '../src/catalog.js';

const mockCatalogConfig: CatalogConfig = {
  baseUrl: 'https://dummyjson.com/products',
  timeoutMs: 150,
  delayMs: 0,
};

function createMockFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(input);

    // Producto 99999 -> 404 Not Found
    if (urlStr.includes('/99999')) {
      return new Response(JSON.stringify({ message: 'Product not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Producto 888 -> Simula un catálogo que tarda más que el timeout
    if (urlStr.includes('/888')) {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }

    // Extraer ID de la URL
    const match = urlStr.match(/\/products\/(\d+)/);
    const id = match ? Number(match[1]) : 1;

    return new Response(
      JSON.stringify({
        id,
        title: `Producto Mock #${id}`,
        price: id * 10,
        thumbnail: `https://dummyjson.com/image/${id}`,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }) as typeof fetch;
}

describe('1. Validación del contrato de mensajes (validation.ts)', () => {
  it('rechaza JSON malformado sin lanzar excepciones', () => {
    const res = parseAndValidateClientMessage('{ json_roto ');
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, 'INVALID_JSON');
    }
  });

  it('rechaza tipos de mensajes desconocidos', () => {
    const res = parseAndValidateClientMessage(JSON.stringify({ type: 'ACCION_INVENTADA' }));
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, 'UNKNOWN_MESSAGE_TYPE');
    }
  });

  it('valida nombres de participantes: rechaza vacíos y mayores a 25 caracteres', () => {
    const empty = validateParticipantName('   ');
    assert.equal(empty.ok, false);

    const tooLong = validateParticipantName('NombreDemasiadoLargoQueSuperaVeinticincoCaracteres');
    assert.equal(tooLong.ok, false);

    const valid = validateParticipantName('  Lucía  ');
    assert.equal(valid.ok, true);
    if (valid.ok) {
      assert.equal(valid.value, 'Lucía');
    }
  });

  it('valida PROPOSE_PRODUCTS: permite entre 1 y 10 IDs enteros positivos', () => {
    const emptyList = parseAndValidateClientMessage(
      JSON.stringify({ type: 'PROPOSE_PRODUCTS', productIds: [] })
    );
    assert.equal(emptyList.ok, false);

    const moreThanTen = parseAndValidateClientMessage(
      JSON.stringify({
        type: 'PROPOSE_PRODUCTS',
        productIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      })
    );
    assert.equal(moreThanTen.ok, false);
    if (!moreThanTen.ok) {
      assert.equal(moreThanTen.code, 'INVALID_PRODUCT_IDS');
    }

    const negativeId = parseAndValidateClientMessage(
      JSON.stringify({ type: 'PROPOSE_PRODUCTS', productIds: [1, -5] })
    );
    assert.equal(negativeId.ok, false);

    const validProposal = parseAndValidateClientMessage(
      JSON.stringify({ type: 'PROPOSE_PRODUCTS', productIds: [1, 2, 3] })
    );
    assert.equal(validProposal.ok, true);
  });
});

describe('2. Lógica de la lista compartida, concurrencia y tolerancia a fallos (state.ts)', () => {
  it('impide nombres repetidos simultáneos y actualiza al salir', () => {
    const room = new GiftRoom('general');
    const j1 = room.addParticipant('Martín');
    assert.equal(j1.ok, true);

    const j2 = room.addParticipant('martín'); // case-insensitive
    assert.equal(j2.ok, false);
    if (!j2.ok) {
      assert.equal(j2.code, 'NAME_TAKEN');
    }

    room.removeParticipant('Martín');
    const j3 = room.addParticipant('Martín');
    assert.equal(j3.ok, true);
  });

  it('agrega productos válidos e informa fallos parciales (inexistente, timeout y ya en lista)', async () => {
    const room = new GiftRoom('general');
    room.addParticipant('Ana');
    const mockFetch = createMockFetch();

    // Primera propuesta: ID 1 (válido), ID 99999 (inexistente -> NOT_FOUND), ID 888 (lento -> TIMEOUT)
    const first = await room.proposeProducts(
      'Ana',
      [1, 99999, 888],
      mockCatalogConfig,
      mockFetch
    );

    assert.equal(first.stateChanged, true);
    assert.equal(first.result.added.length, 1);
    assert.equal(first.result.added[0].id, 1);
    assert.equal(first.result.failed.length, 2);

    const reasons = first.result.failed.map((f) => f.reason).sort();
    assert.deepEqual(reasons, ['NOT_FOUND', 'TIMEOUT']);

    // Segunda propuesta intentando volver a agregar el ID 1 junto con el ID 2
    const second = await room.proposeProducts(
      'Ana',
      [1, 2],
      mockCatalogConfig,
      mockFetch
    );

    assert.equal(second.result.added.length, 1);
    assert.equal(second.result.added[0].id, 2);
    assert.equal(second.result.failed.length, 1);
    assert.equal(second.result.failed[0].productId, 1);
    assert.equal(second.result.failed[0].reason, 'ALREADY_IN_LIST');
  });

  it('mantiene la consistencia si dos participantes proponen el mismo producto al mismo tiempo', async () => {
    const room = new GiftRoom('general');
    room.addParticipant('Ana');
    room.addParticipant('Bruno');
    const mockFetch = createMockFetch();

    const [p1, p2] = await Promise.all([
      room.proposeProducts('Ana', [10], mockCatalogConfig, mockFetch),
      room.proposeProducts('Bruno', [10], mockCatalogConfig, mockFetch),
    ]);

    const snapshot = room.getSnapshot();
    assert.equal(snapshot.products.length, 1);
    assert.equal(snapshot.products[0].id, 10);

    const totalAdded = p1.result.added.length + p2.result.added.length;
    const totalFailed = p1.result.failed.length + p2.result.failed.length;
    assert.equal(totalAdded, 1);
    assert.equal(totalFailed, 1);
  });

  it('ordena por cantidad de votos, impide voto doble y aplica la regla para quitar productos', async () => {
    const room = new GiftRoom('general');
    room.addParticipant('Ana');
    room.addParticipant('Bruno');
    const mockFetch = createMockFetch();

    await room.proposeProducts('Ana', [1, 2], mockCatalogConfig, mockFetch);

    // Ana y Bruno votan el producto 2
    assert.equal(room.voteProduct('Ana', 2).ok, true);
    assert.equal(room.voteProduct('Bruno', 2).ok, true);

    // Ana intenta votar de nuevo el producto 2 -> error ALREADY_VOTED
    const duplicateVote = room.voteProduct('Ana', 2);
    assert.equal(duplicateVote.ok, false);
    if (!duplicateVote.ok) {
      assert.equal(duplicateVote.code, 'ALREADY_VOTED');
    }

    // Ranking debe tener primero al producto 2 (2 votos) y luego al 1 (0 votos)
    let snap = room.getSnapshot();
    assert.equal(snap.products[0].id, 2);
    assert.equal(snap.products[0].voteCount, 2);
    assert.equal(snap.products[1].id, 1);
    assert.equal(snap.products[1].voteCount, 0);

    // Regla de quitar: Bruno (no propuso el 2, y el 2 tiene votos) NO puede quitar el 2
    const forbiddenRemove = room.removeProduct('Bruno', 2);
    assert.equal(forbiddenRemove.ok, false);
    if (!forbiddenRemove.ok) {
      assert.equal(forbiddenRemove.code, 'FORBIDDEN_ACTION');
    }

    // Pero Bruno SÍ puede quitar el producto 1 porque tiene 0 votos
    assert.equal(room.removeProduct('Bruno', 1).ok, true);

    // Y Ana SÍ puede quitar el producto 2 porque ella lo propuso
    assert.equal(room.removeProduct('Ana', 2).ok, true);

    snap = room.getSnapshot();
    assert.equal(snap.products.length, 0);
  });
});

import { createAppServer } from '../src/server.js';

describe('3. Integración de Protocolo WebSocket (/ws) y Broadcast entre Clientes', () => {
  it('aisla errores al emisor, sincroniza a los demás participantes y limpia conexiones cerradas', async () => {
    const app = createAppServer({
      catalogBaseUrl: 'https://dummyjson.com/products',
      catalogTimeoutMs: 500,
      catalogDelayMs: 0,
      fetchImpl: createMockFetch(),
    });

    try {
      const client1 = app.createInMemorySession();
      const client2 = app.createInMemorySession();

      // 1. Mensaje inválido enviado por client1 -> solo client1 recibe ERROR y el servidor sigue funcionando
      await client1.sendRaw('{ json_invalido ');
      assert.equal(client1.outbox.length, 1);
      assert.equal(client1.outbox[0].type, 'ERROR');
      if (client1.outbox[0].type === 'ERROR') {
        assert.equal(client1.outbox[0].code, 'INVALID_JSON');
      }
      assert.equal(client2.outbox.length, 0);

      // 2. Client 1 hace JOIN como "Carlos"
      client1.outbox.length = 0;
      await client1.sendJson({ type: 'JOIN', name: 'Carlos' });
      assert.equal(client1.outbox[0].type, 'WELCOME');

      // 3. Client 2 entra más tarde como "Sofía" -> ve inmediatamente a Carlos conectado
      await client2.sendJson({ type: 'JOIN', name: 'Sofía' });
      assert.equal(client2.outbox[0].type, 'WELCOME');
      if (client2.outbox[0].type === 'WELCOME') {
        assert.deepEqual(client2.outbox[0].state.participants, ['Carlos', 'Sofía']);
      }

      // 4. Carlos propone [1, 99999] (1 válido, 99999 inexistente)
      client1.outbox.length = 0;
      client2.outbox.length = 0;
      await client1.sendJson({ type: 'PROPOSE_PRODUCTS', productIds: [1, 99999] });

      // Carlos recibe PROPOSAL_RESULT (con el fallo de 99999) + STATE_UPDATED
      const carlosProposalMsg = client1.outbox.find((m) => m.type === 'PROPOSAL_RESULT');
      assert.ok(carlosProposalMsg && carlosProposalMsg.type === 'PROPOSAL_RESULT');
      assert.equal(carlosProposalMsg.result.added.length, 1);
      assert.equal(carlosProposalMsg.result.failed.length, 1);
      assert.equal(carlosProposalMsg.result.failed[0].reason, 'NOT_FOUND');

      // Sofía NO recibe PROPOSAL_RESULT (no ve errores ajenos), solo recibe STATE_UPDATED con el producto 1
      assert.equal(
        client2.outbox.some((m) => m.type === 'PROPOSAL_RESULT'),
        false
      );
      const sofiaStateMsg = client2.outbox.find((m) => m.type === 'STATE_UPDATED');
      assert.ok(sofiaStateMsg && sofiaStateMsg.type === 'STATE_UPDATED');
      assert.equal(sofiaStateMsg.state.products.length, 1);
      assert.equal(sofiaStateMsg.state.products[0].id, 1);

      // 5. Sofía cierra su pestaña -> Carlos ve un participante menos
      client1.outbox.length = 0;
      client2.disconnect();
      const leftMsg = client1.outbox.find((m) => m.type === 'STATE_UPDATED');
      assert.ok(leftMsg && leftMsg.type === 'STATE_UPDATED');
      assert.equal(leftMsg.reason, 'PARTICIPANT_LEFT');
      assert.deepEqual(leftMsg.state.participants, ['Carlos']);
    } finally {
      await app.close();
    }
  });
});

