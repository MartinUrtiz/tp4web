import http, { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { CatalogConfig } from './catalog.js';
import { RoomManager } from './state.js';
import {
  ErrorServerMessage,
  ServerErrorCode,
  ServerToClientMessage,
  StateUpdatedServerMessage,
} from './types.js';
import { parseAndValidateClientMessage, validateRoomCode } from './validation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../public');

export interface ServerOptions {
  port?: number;
  catalogBaseUrl?: string;
  catalogTimeoutMs?: number;
  catalogDelayMs?: number;
  heartbeatIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

interface ConnectedParticipant {
  ws: WebSocket;
  name: string | null;
  roomCode: string;
  isAlive: boolean;
}

interface SseClient {
  id: string;
  roomCode: string;
  res: ServerResponse;
}

export const REMOVE_POLICY_DESCRIPTION =
  'Puede quitar un producto quien lo propuso, o cualquier participante si el producto tiene 0 votos.';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function createAppServer(options: ServerOptions = {}) {
  const catalogConfig: CatalogConfig = {
    baseUrl:
      options.catalogBaseUrl ??
      process.env.CATALOG_BASE_URL ??
      'https://dummyjson.com/products',
    timeoutMs: Number(
      options.catalogTimeoutMs ?? process.env.CATALOG_TIMEOUT_MS ?? 4000
    ),
    delayMs: Number(
      options.catalogDelayMs ?? process.env.CATALOG_DELAY_MS ?? 0
    ),
  };

  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  const fetchImpl = options.fetchImpl ?? fetch;

  const roomManager = new RoomManager();
  const wsClients = new Set<ConnectedParticipant>();
  const sseClients = new Set<SseClient>();

  function sendWsMessage(ws: WebSocket, message: ServerToClientMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  function sendWsError(
    ws: WebSocket,
    code: ServerErrorCode,
    message: string,
    details?: unknown
  ): void {
    const errorMsg: ErrorServerMessage = {
      type: 'ERROR',
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    };
    sendWsMessage(ws, errorMsg);
  }

  function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  /**
   * Notifica un cambio de estado a todos los participantes conectados por WebSocket
   * y a todas las pantallas conectadas por Server-Sent Events (SSE) de la misma sala.
   */
  function broadcastRoomState(
    roomCode: string,
    reason: StateUpdatedServerMessage['reason'],
    actor?: string
  ): void {
    const room = roomManager.getOrCreateRoom(roomCode);
    const snapshot = room.getSnapshot();

    const wsUpdate: StateUpdatedServerMessage = {
      type: 'STATE_UPDATED',
      reason,
      actor,
      state: snapshot,
    };

    for (const client of wsClients) {
      if (client.name !== null && client.roomCode === roomCode) {
        sendWsMessage(client.ws, wsUpdate);
      }
    }

    for (const sse of sseClients) {
      if (sse.roomCode === roomCode) {
        writeSseEvent(sse.res, 'state_update', {
          reason,
          actor,
          state: snapshot,
        });
      }
    }
  }

  /**
   * Maneja las conexiones SSE para la pantalla (/events o /api/screen/events)
   */
  function handleSseConnection(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const roomValidation = validateRoomCode(url.searchParams.get('room') ?? 'general');
    const roomCode = roomValidation.ok ? roomValidation.value : 'general';
    const room = roomManager.getOrCreateRoom(roomCode);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sseClient: SseClient = { id: clientId, roomCode, res };
    sseClients.add(sseClient);

    // Comentario inicial y evento initial_state inmediato para que la pantalla vea todo sin esperar cambios
    res.write(`: connected client ${clientId}\n\n`);
    writeSseEvent(res, 'initial_state', room.getSnapshot());

    req.on('close', () => {
      sseClients.delete(sseClient);
      if (!res.writableEnded) {
        res.end();
      }
    });
  }

  /**
   * Sirve archivos estáticos de la carpeta public/ en el mismo servidor y puerto.
   */
  async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? 'localhost';
    const url = new URL(req.url ?? '/', `http://${host}`);

    // Endpoint de Server-Sent Events para la Pantalla
    if (req.method === 'GET' && (url.pathname === '/events' || url.pathname === '/api/events')) {
      handleSseConnection(req, res, url);
      return;
    }

    // Endpoint informativo de salud / configuración actual
    if (req.method === 'GET' && url.pathname === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          catalogBaseUrl: catalogConfig.baseUrl,
          catalogTimeoutMs: catalogConfig.timeoutMs,
          catalogDelayMs: catalogConfig.delayMs,
          removePolicy: REMOVE_POLICY_DESCRIPTION,
        })
      );
      return;
    }

    // Rutas amigables para las páginas
    let relativePath = url.pathname;
    if (relativePath === '/' || relativePath === '/participante') {
      relativePath = '/index.html';
    } else if (relativePath === '/pantalla' || relativePath === '/screen') {
      relativePath = '/pantalla.html';
    } else if (relativePath === '/demo') {
      relativePath = '/demo.html';
    }

    // Prevenir Path Traversal
    const safeSuffix = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
    const filePath = path.join(PUBLIC_DIR, safeSuffix);

    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Acceso denegado');
      return;
    }

    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Recurso no encontrado');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
      const content = await fs.readFile(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Página no encontrada');
    }
  }

  const httpServer = http.createServer((req, res) => {
    handleHttpRequest(req, res).catch((err) => {
      console.error('Error procesando petición HTTP:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      if (!res.writableEnded) {
        res.end('Error interno del servidor');
      }
    });
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  function cleanupParticipantConnection(client: ConnectedParticipant): void {
    if (!wsClients.has(client)) {
      return;
    }
    wsClients.delete(client);

    if (client.name !== null) {
      const leavingName = client.name;
      const roomCode = client.roomCode;
      client.name = null;
      const room = roomManager.getOrCreateRoom(roomCode);
      const removed = room.removeParticipant(leavingName);
      if (removed) {
        broadcastRoomState(roomCode, 'PARTICIPANT_LEFT', leavingName);
      }
    }
  }

  /**
   * Procesa un mensaje crudo recibido desde un cliente WebSocket.
   * Expuesto también como helper interno para facilitar pruebas unitarias y de integración sin depender de sockets de red.
   */
  async function processClientRawMessage(
    client: ConnectedParticipant,
    rawText: string
  ): Promise<void> {
    const ws = client.ws;
    client.isAlive = true;
    const validation = parseAndValidateClientMessage(rawText);

    if (!validation.ok) {
      sendWsError(ws, validation.code, validation.message);
      return;
    }

    const msg = validation.value;

    if (msg.type === 'PING') {
      sendWsMessage(ws, {
        type: 'PONG',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (msg.type === 'JOIN') {
      if (client.name !== null) {
        sendWsError(
          ws,
          'ALREADY_JOINED',
          `Ya ingresaste a la sala como "${client.name}".`
        );
        return;
      }

      const roomCode = msg.roomCode ?? 'general';
      const room = roomManager.getOrCreateRoom(roomCode);
      const joinResult = room.addParticipant(msg.name);

      if (!joinResult.ok) {
        sendWsError(ws, joinResult.code, joinResult.message);
        return;
      }

      client.name = joinResult.value.name;
      client.roomCode = roomCode;

      // 1. Enviar estado inicial completo al participante que acaba de entrar (Requisito 2)
      sendWsMessage(ws, {
        type: 'WELCOME',
        name: client.name,
        roomCode,
        state: joinResult.value.state,
        config: {
          catalogTimeoutMs: catalogConfig.timeoutMs,
          catalogDelayMs: catalogConfig.delayMs,
          removePolicy: REMOVE_POLICY_DESCRIPTION,
        },
      });

      // 2. Notificar a todos los participantes y a la pantalla que alguien entró (Requisito 3)
      broadcastRoomState(roomCode, 'PARTICIPANT_JOINED', client.name);
      return;
    }

    // A partir de aquí, todas las acciones requieren que el participante haya hecho JOIN
    if (client.name === null) {
      sendWsError(
        ws,
        'NOT_AUTHENTICATED',
        'Debés ingresar con tu nombre enviando un mensaje JOIN antes de realizar acciones.'
      );
      return;
    }

    const currentName = client.name;
    const currentRoomCode = client.roomCode;
    const room = roomManager.getOrCreateRoom(currentRoomCode);

    switch (msg.type) {
      case 'PROPOSE_PRODUCTS': {
        try {
          const { result, stateChanged } = await room.proposeProducts(
            currentName,
            msg.productIds,
            catalogConfig,
            fetchImpl,
            msg.requestId
          );

          // Informar el detalle de éxitos y fallos SOLO a quien hizo la propuesta (Requisitos 6 y 7)
          sendWsMessage(ws, {
            type: 'PROPOSAL_RESULT',
            result,
          });

          // Si al menos un producto se agregó, todos los participantes y la pantalla ven la lista actualizada
          if (stateChanged) {
            broadcastRoomState(currentRoomCode, 'PRODUCTS_ADDED', currentName);
          }
        } catch (err) {
          console.error('Error inesperado al proponer productos:', err);
          sendWsError(
            ws,
            'INVALID_MESSAGE_FORMAT',
            'Ocurrió un error interno procesando la propuesta.'
          );
        }
        break;
      }

      case 'VOTE_PRODUCT': {
        const voteResult = room.voteProduct(currentName, msg.productId);
        if (!voteResult.ok) {
          sendWsError(ws, voteResult.code, voteResult.message);
          return;
        }
        broadcastRoomState(currentRoomCode, 'VOTE_CHANGED', currentName);
        break;
      }

      case 'UNVOTE_PRODUCT': {
        const unvoteResult = room.unvoteProduct(currentName, msg.productId);
        if (!unvoteResult.ok) {
          sendWsError(ws, unvoteResult.code, unvoteResult.message);
          return;
        }
        broadcastRoomState(currentRoomCode, 'VOTE_CHANGED', currentName);
        break;
      }

      case 'REMOVE_PRODUCT': {
        const removeResult = room.removeProduct(currentName, msg.productId);
        if (!removeResult.ok) {
          sendWsError(ws, removeResult.code, removeResult.message);
          return;
        }
        broadcastRoomState(currentRoomCode, 'PRODUCT_REMOVED', currentName);
        break;
      }
    }
  }

  wss.on('connection', (ws: WebSocket) => {
    const client: ConnectedParticipant = {
      ws,
      name: null,
      roomCode: 'general',
      isAlive: true,
    };
    wsClients.add(client);

    ws.on('pong', () => {
      client.isAlive = true;
    });

    ws.on('message', async (rawData) => {
      const rawText = typeof rawData === 'string' ? rawData : rawData.toString('utf-8');
      await processClientRawMessage(client, rawText);
    });

    ws.on('close', () => {
      cleanupParticipantConnection(client);
    });

    ws.on('error', () => {
      cleanupParticipantConnection(client);
    });
  });

  // Detección de conexiones muertas con ping/pong (Opcional implementado) + keep-alive de SSE
  const heartbeatTimer = setInterval(() => {
    for (const client of wsClients) {
      if (!client.isAlive) {
        client.ws.terminate();
        cleanupParticipantConnection(client);
        continue;
      }
      client.isAlive = false;
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.ping();
      }
    }

    for (const sse of sseClients) {
      if (sse.res.writableEnded || sse.res.destroyed) {
        sseClients.delete(sse);
      } else {
        sse.res.write(`: heartbeat ${Date.now()}\n\n`);
      }
    }
  }, heartbeatIntervalMs);

  heartbeatTimer.unref();

  async function close(): Promise<void> {
    clearInterval(heartbeatTimer);

    for (const sse of sseClients) {
      if (!sse.res.writableEnded) {
        sse.res.end();
      }
    }
    sseClients.clear();

    for (const client of wsClients) {
      client.ws.terminate();
    }
    wsClients.clear();

    await new Promise<void>((resolve) => {
      wss.close(() => {
        httpServer.close(() => resolve());
      });
    });
  }

  /**
   * Conecta un cliente WebSocket simulado en memoria (útil para tests automatizados sin sockets TCP).
   */
  function createInMemorySession() {
    const outbox: ServerToClientMessage[] = [];
    const fakeWs = {
      readyState: WebSocket.OPEN,
      send(payload: string) {
        outbox.push(JSON.parse(payload) as ServerToClientMessage);
      },
      ping() {},
      terminate() {},
    } as unknown as WebSocket;

    const client: ConnectedParticipant = {
      ws: fakeWs,
      name: null,
      roomCode: 'general',
      isAlive: true,
    };
    wsClients.add(client);

    return {
      outbox,
      sendRaw: (raw: string) => processClientRawMessage(client, raw),
      sendJson: (obj: unknown) => processClientRawMessage(client, JSON.stringify(obj)),
      disconnect: () => cleanupParticipantConnection(client),
    };
  }

  return {
    httpServer,
    wss,
    roomManager,
    catalogConfig,
    createInMemorySession,
    close,
  };
}

function getLocalNetworkAddresses(): string[] {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];
  for (const list of Object.values(interfaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

// Punto de entrada cuando se ejecuta directamente (`npm start` o `npm run dev`)
const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const port = Number(process.env.PORT ?? 3000);
  const app = createAppServer({ port });

  app.httpServer.listen(port, '0.0.0.0', () => {
    const lanIps = getLocalNetworkAddresses();
    console.log('==============================================================');
    console.log('🎁 TP4 - Lista Compartida de Regalo Grupal (Node.js + TS)');
    console.log('==============================================================');
    console.log(`▶ Participante (WebSocket): http://localhost:${port}/`);
    console.log(`▶ Pantalla En Vivo (SSE):   http://localhost:${port}/pantalla`);
    if (lanIps.length > 0) {
      console.log(`▶ Acceso en red local (LAN): http://${lanIps[0]}:${port}/`);
    }
    console.log('--------------------------------------------------------------');
    console.log(`⚙ Catálogo URL:     ${app.catalogConfig.baseUrl}`);
    console.log(`⏱ Catálogo Timeout: ${app.catalogConfig.timeoutMs} ms`);
    console.log(`🐢 Catálogo Delay:   ${app.catalogConfig.delayMs} ms`);
    console.log('==============================================================');
  });
}
