/**
 * Tipos de dominio y Contrato de Mensajes (WebSocket y Server-Sent Events)
 */

export interface CatalogProduct {
  id: number;
  title: string;
  price: number;
  thumbnail: string;
  category?: string;
  brand?: string;
}

export interface ProductItem {
  id: number;
  title: string;
  price: number;
  thumbnail: string;
  proposedBy: string;
  proposedAt: string;
  votes: string[]; // Lista de nombres de participantes que votaron este producto
  voteCount: number;
}

export interface RoomStateSnapshot {
  roomCode: string;
  participants: string[];
  participantCount: number;
  products: ProductItem[];
  updatedAt: string;
}

/**
 * Motivos explícitos de fallo al proponer un producto (Requisito 6)
 */
export type ProposalErrorReason =
  | 'NOT_FOUND'        // Producto inexistente en el catálogo (404)
  | 'TIMEOUT'          // El catálogo no respondió a tiempo
  | 'ALREADY_IN_LIST'  // El producto ya estaba en la lista
  | 'CATALOG_ERROR';   // Otro error de red o HTTP del servicio externo

export interface ProposalFailureItem {
  productId: number;
  reason: ProposalErrorReason;
  message: string;
}

export interface ProposalResultPayload {
  requestId?: string;
  added: ProductItem[];
  failed: ProposalFailureItem[];
}

// ============================================================================
// MENSAJES CLIENTE -> SERVIDOR (WebSocket)
// ============================================================================

export interface JoinClientMessage {
  type: 'JOIN';
  name: string;
  roomCode?: string;
}

export interface ProposeProductsClientMessage {
  type: 'PROPOSE_PRODUCTS';
  productIds: number[];
  requestId?: string;
}

export interface VoteProductClientMessage {
  type: 'VOTE_PRODUCT';
  productId: number;
}

export interface UnvoteProductClientMessage {
  type: 'UNVOTE_PRODUCT';
  productId: number;
}

export interface RemoveProductClientMessage {
  type: 'REMOVE_PRODUCT';
  productId: number;
}

export interface PingClientMessage {
  type: 'PING';
}

export type ClientToServerMessage =
  | JoinClientMessage
  | ProposeProductsClientMessage
  | VoteProductClientMessage
  | UnvoteProductClientMessage
  | RemoveProductClientMessage
  | PingClientMessage;

// ============================================================================
// MENSAJES SERVIDOR -> CLIENTE (WebSocket)
// ============================================================================

export interface WelcomeServerMessage {
  type: 'WELCOME';
  name: string;
  roomCode: string;
  state: RoomStateSnapshot;
  config: {
    catalogTimeoutMs: number;
    catalogDelayMs: number;
    removePolicy: string;
  };
}

export interface StateUpdatedServerMessage {
  type: 'STATE_UPDATED';
  reason:
    | 'PARTICIPANT_JOINED'
    | 'PARTICIPANT_LEFT'
    | 'PRODUCTS_ADDED'
    | 'VOTE_CHANGED'
    | 'PRODUCT_REMOVED';
  actor?: string;
  state: RoomStateSnapshot;
}

export interface ProposalResultServerMessage {
  type: 'PROPOSAL_RESULT';
  result: ProposalResultPayload;
}

export type ServerErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_MESSAGE_FORMAT'
  | 'UNKNOWN_MESSAGE_TYPE'
  | 'NOT_AUTHENTICATED'
  | 'ALREADY_JOINED'
  | 'INVALID_NAME'
  | 'NAME_TAKEN'
  | 'INVALID_ROOM_CODE'
  | 'INVALID_PRODUCT_IDS'
  | 'PRODUCT_NOT_IN_LIST'
  | 'ALREADY_VOTED'
  | 'VOTE_NOT_FOUND'
  | 'FORBIDDEN_ACTION';

export interface ErrorServerMessage {
  type: 'ERROR';
  code: ServerErrorCode;
  message: string;
  details?: unknown;
}

export interface PongServerMessage {
  type: 'PONG';
  timestamp: string;
}

export type ServerToClientMessage =
  | WelcomeServerMessage
  | StateUpdatedServerMessage
  | ProposalResultServerMessage
  | ErrorServerMessage
  | PongServerMessage;

// ============================================================================
// EVENTOS SERVIDOR -> PANTALLA (Server-Sent Events / EventSource)
// ============================================================================

export interface SseInitialStateEvent {
  event: 'initial_state';
  data: RoomStateSnapshot;
}

export interface SseStateUpdateEvent {
  event: 'state_update';
  data: {
    reason: StateUpdatedServerMessage['reason'];
    actor?: string;
    state: RoomStateSnapshot;
  };
}
