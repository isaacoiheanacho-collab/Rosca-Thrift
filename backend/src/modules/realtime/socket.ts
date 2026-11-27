import { Server, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { env } from '../../config/env';
import { logger } from '../../logger';

let socketServer: Server | null = null;

/**
 * Attach the realtime transport to the HTTP server.
 *
 * Business events will be added alongside their authenticated domain modules.
 * Until then, the transport deliberately exposes no unauthenticated data events.
 */
export function initSocketIO(httpServer: HttpServer): Server {
  if (socketServer) return socketServer;

  socketServer = new Server(httpServer, {
    cors: {
      origin: env.CORS_ORIGINS_LIST,
      credentials: true,
    },
    serveClient: false,
    transports: ['websocket', 'polling'],
  });

  socketServer.on('connection', (socket: Socket) => {
    logger.debug({ socketId: socket.id }, 'Realtime client connected');
    socket.on('disconnect', (reason) => {
      logger.debug({ socketId: socket.id, reason }, 'Realtime client disconnected');
    });
  });

  return socketServer;
}

export async function closeSocketIO(): Promise<void> {
  if (!socketServer) return;
  const current = socketServer;
  socketServer = null;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}
