import { CatalogProduct, ProposalErrorReason } from './types.js';

export interface CatalogConfig {
  baseUrl: string;
  timeoutMs: number;
  delayMs: number;
}

export type CatalogFetchOutcome =
  | {
      ok: true;
      productId: number;
      product: CatalogProduct;
    }
  | {
      ok: false;
      productId: number;
      reason: ProposalErrorReason;
      message: string;
    };

/**
 * Construye la URL para consultar un producto en DummyJSON.
 * Si `delayMs > 0`, agrega el parámetro `?delay=<ms>` que soporta DummyJSON
 * para simular un catálogo lento sin modificar el código.
 */
export function buildProductUrl(baseUrl: string, productId: number, delayMs: number): string {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const url = new URL(`${cleanBase}/${encodeURIComponent(String(productId))}`);
  if (delayMs > 0) {
    url.searchParams.set('delay', String(delayMs));
  }
  return url.toString();
}

/**
 * Consulta un único producto del catálogo con tiempo máximo de espera (AbortSignal.timeout).
 */
export async function fetchProductFromCatalog(
  productId: number,
  config: CatalogConfig,
  fetchImpl: typeof fetch = fetch
): Promise<CatalogFetchOutcome> {
  const url = buildProductUrl(config.baseUrl, productId, config.delayMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (response.status === 404) {
      return {
        ok: false,
        productId,
        reason: 'NOT_FOUND',
        message: `El producto #${productId} no existe en el catálogo.`,
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        productId,
        reason: 'CATALOG_ERROR',
        message: `El catálogo respondió con estado HTTP ${response.status} para el producto #${productId}.`,
      };
    }

    const data = (await response.json()) as Record<string, unknown>;

    if (
      typeof data !== 'object' ||
      data === null ||
      typeof data.id !== 'number' ||
      typeof data.title !== 'string' ||
      typeof data.price !== 'number'
    ) {
      return {
        ok: false,
        productId,
        reason: 'CATALOG_ERROR',
        message: `El catálogo devolvió datos incompletos para el producto #${productId}.`,
      };
    }

    const thumbnail =
      typeof data.thumbnail === 'string' && data.thumbnail.length > 0
        ? data.thumbnail
        : Array.isArray(data.images) && typeof data.images[0] === 'string'
        ? data.images[0]
        : '';

    return {
      ok: true,
      productId,
      product: {
        id: data.id,
        title: data.title,
        price: data.price,
        thumbnail,
        category: typeof data.category === 'string' ? data.category : undefined,
        brand: typeof data.brand === 'string' ? data.brand : undefined,
      },
    };
  } catch (err: unknown) {
    const isAbortError =
      err instanceof Error &&
      (err.name === 'AbortError' || err.name === 'TimeoutError' || controller.signal.aborted);

    if (isAbortError) {
      return {
        ok: false,
        productId,
        reason: 'TIMEOUT',
        message: `El catálogo no respondió a tiempo para el producto #${productId} (límite: ${config.timeoutMs} ms).`,
      };
    }

    return {
      ok: false,
      productId,
      reason: 'CATALOG_ERROR',
      message: `Error de conexión al consultar el catálogo para el producto #${productId}.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Consulta varios productos en simultáneo (Promise.all).
 */
export async function fetchManyProductsConcurrently(
  productIds: number[],
  config: CatalogConfig,
  fetchImpl: typeof fetch = fetch
): Promise<CatalogFetchOutcome[]> {
  return Promise.all(
    productIds.map((productId) => fetchProductFromCatalog(productId, config, fetchImpl))
  );
}
