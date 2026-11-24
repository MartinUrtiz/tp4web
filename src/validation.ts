import { ClientToServerMessage, ServerErrorCode } from './types.js';

export const MAX_NAME_LENGTH = 25;
export const MIN_NAME_LENGTH = 2;
export const MAX_PRODUCTS_PER_PROPOSAL = 10;
export const MAX_ROOM_CODE_LENGTH = 20;

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ServerErrorCode; message: string };

/**
 * Valida las reglas de negocio para el nombre de un participante:
 * - Debe ser un string
 * - Se eliminan espacios al inicio y al final (trim)
 * - No puede ser vacío (mínimo 2 caracteres)
 * - Largo máximo: 25 caracteres
 * - Solo caracteres imprimibles válidos (letras, números, espacios, guiones y guiones bajos)
 */
export function validateParticipantName(rawName: unknown): ValidationResult<string> {
  if (typeof rawName !== 'string') {
    return {
      ok: false,
      code: 'INVALID_NAME',
      message: 'El nombre debe ser una cadena de texto.',
    };
  }

  const trimmed = rawName.trim().replace(/\s+/g, ' ');
  if (trimmed.length < MIN_NAME_LENGTH) {
    return {
      ok: false,
      code: 'INVALID_NAME',
      message: `El nombre no puede estar vacío y debe tener al menos ${MIN_NAME_LENGTH} caracteres.`,
    };
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    return {
      ok: false,
      code: 'INVALID_NAME',
      message: `El nombre no puede superar los ${MAX_NAME_LENGTH} caracteres.`,
    };
  }

  const validPattern = /^[\p{L}\p{N}_\- .]+$/u;
  if (!validPattern.test(trimmed)) {
    return {
      ok: false,
      code: 'INVALID_NAME',
      message: 'El nombre solo puede contener letras, números, espacios, puntos, guiones o guiones bajos.',
    };
  }

  return { ok: true, value: trimmed };
}

/**
 * Valida el código de sala (opcional, por defecto "general").
 */
export function validateRoomCode(rawRoomCode: unknown): ValidationResult<string> {
  if (rawRoomCode === undefined || rawRoomCode === null || rawRoomCode === '') {
    return { ok: true, value: 'general' };
  }
  if (typeof rawRoomCode !== 'string') {
    return {
      ok: false,
      code: 'INVALID_ROOM_CODE',
      message: 'El código de sala debe ser una cadena de texto.',
    };
  }
  const normalized = rawRoomCode.trim().toLowerCase();
  if (normalized.length === 0) {
    return { ok: true, value: 'general' };
  }
  if (normalized.length > MAX_ROOM_CODE_LENGTH || !/^[a-z0-9_-]+$/.test(normalized)) {
    return {
      ok: false,
      code: 'INVALID_ROOM_CODE',
      message: `El código de sala debe ser alfanumérico (máx. ${MAX_ROOM_CODE_LENGTH} caracteres).`,
    };
  }
  return { ok: true, value: normalized };
}

/**
 * Valida un ID de producto individual (entero positivo > 0).
 */
export function isValidProductId(id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id > 0 && id <= 1_000_000;
}

/**
 * Parsea y valida cualquier mensaje crudo recibido por WebSocket desde un cliente.
 * Nunca lanza una excepción no controlada.
 */
export function parseAndValidateClientMessage(rawPayload: string): ValidationResult<ClientToServerMessage> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    return {
      ok: false,
      code: 'INVALID_JSON',
      message: 'El mensaje enviado no es un JSON válido.',
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      code: 'INVALID_MESSAGE_FORMAT',
      message: 'El mensaje JSON debe ser un objeto con la propiedad "type".',
    };
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.type !== 'string') {
    return {
      ok: false,
      code: 'INVALID_MESSAGE_FORMAT',
      message: 'Falta el campo obligatorio "type" (string) en el mensaje.',
    };
  }

  switch (record.type) {
    case 'JOIN': {
      const nameResult = validateParticipantName(record.name);
      if (!nameResult.ok) {
        return nameResult;
      }
      const roomResult = validateRoomCode(record.roomCode);
      if (!roomResult.ok) {
        return roomResult;
      }
      return {
        ok: true,
        value: {
          type: 'JOIN',
          name: nameResult.value,
          roomCode: roomResult.value,
        },
      };
    }

    case 'PROPOSE_PRODUCTS': {
      if (!Array.isArray(record.productIds)) {
        return {
          ok: false,
          code: 'INVALID_PRODUCT_IDS',
          message: 'El campo "productIds" debe ser un arreglo de números enteros positivos.',
        };
      }

      if (record.productIds.length === 0) {
        return {
          ok: false,
          code: 'INVALID_PRODUCT_IDS',
          message: 'Debés proponer al menos 1 producto.',
        };
      }

      if (record.productIds.length > MAX_PRODUCTS_PER_PROPOSAL) {
        return {
          ok: false,
          code: 'INVALID_PRODUCT_IDS',
          message: `No se pueden proponer más de ${MAX_PRODUCTS_PER_PROPOSAL} productos en una sola acción (recibidos: ${record.productIds.length}).`,
        };
      }

      const validatedIds: number[] = [];
      for (const item of record.productIds) {
        if (!isValidProductId(item)) {
          return {
            ok: false,
            code: 'INVALID_PRODUCT_IDS',
            message: `Todos los IDs de productos deben ser enteros positivos válidos. Valor inválido: ${JSON.stringify(item)}.`,
          };
        }
        validatedIds.push(item);
      }

      const requestId =
        typeof record.requestId === 'string' && record.requestId.trim().length > 0
          ? record.requestId.trim().slice(0, 64)
          : undefined;

      return {
        ok: true,
        value: {
          type: 'PROPOSE_PRODUCTS',
          productIds: validatedIds,
          requestId,
        },
      };
    }

    case 'VOTE_PRODUCT':
    case 'UNVOTE_PRODUCT':
    case 'REMOVE_PRODUCT': {
      if (!isValidProductId(record.productId)) {
        return {
          ok: false,
          code: 'INVALID_PRODUCT_IDS',
          message: 'El campo "productId" es obligatorio y debe ser un número entero positivo.',
        };
      }
      return {
        ok: true,
        value: {
          type: record.type,
          productId: record.productId,
        },
      };
    }

    case 'PING': {
      return {
        ok: true,
        value: { type: 'PING' },
      };
    }

    default: {
      return {
        ok: false,
        code: 'UNKNOWN_MESSAGE_TYPE',
        message: `Tipo de mensaje desconocido: "${record.type}". Tipos soportados: JOIN, PROPOSE_PRODUCTS, VOTE_PRODUCT, UNVOTE_PRODUCT, REMOVE_PRODUCT, PING.`,
      };
    }
  }
}
