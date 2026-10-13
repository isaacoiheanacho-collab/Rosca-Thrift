/**
 * Socket.IO server.
 *
 * Attaches to the existing HTTP server. Authenticates each connection via
 * the JWT access token (passed in the `auth.token` handshake field).
 *
 * Users are joined to a personal room ("user:<userId>"). All emits are
 * addressed to rooms so we never have to track socket IDs manually.
 *
 * Emitted events (client listens):
 *   notification:new     { id, kind, title, body, createdAt, metadata }
 *
 * Design notes:
 *   - Socket.IO is used for LIVE updates only. Persistent history lives in
 *     the notifications table. If a socket is not connected, no message is
 *     lost — the user still sees the notification via the feed + web push.
 *   - No group/tenant rooms. All routing is by user ID. Simpler + safer.
 */

import { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { env } from '../../config/env';
import { logger } from '../../logger';
import { verifyAccessToken, type JwtPayload } from '../../utils/jwt';

let io: SocketIOServer | null = null;

interface SocketAuthToken {
  sub: string;
  role: JwtPayload['role'];
  branchId: string | null;
}

interface AuthedSocket extends Socket {
  auth?: SocketAuthToken;
}

function roomFor(userId: string): string {
  return `user:${userId}`;
}

export function initSocketIO(httpServer: HttpServer): SocketIOServer {
  if (io) return io;

  io = new SocketIOServer(httpServer, {
    cors: {
      origin: env.CORS_ORIGINS_LIST,
      credentials: true,
    },
    // Default path is /socket.io — fine, no need to change.
    transports: ['websocket', 'polling'],
  });

  io.use((socket: AuthedSocket, next) => {
    const token = (socket.handshake.auth?.token as string | undefined) ?? '';
    if (!token) {
      next(new Error('AUTH_REQUIRED'));
      return;
    }
    try {
      const payload = verifyAccessToken(token);
      socket.auth = {
        sub: payload.sub,
        role: payload.role,
        branchId: payload.branchId ?? null,
      };
      next();
    } catch {
      next(new Error('AUTH_TOKEN_INVALID'));
    }
  });

  io.on('connection', (socket: AuthedSocket) => {
    const userId = socket.auth?.sub;
    if (!userId) {
      socket.disconnect(true);
      return;
    }
    socket.join(roomFor(userId));
    logger.debug({ userId, socketId: socket.id }, 'Socket.IO connected');

    socket.on('disconnect', (reason) => {
      logger.debug({ userId, socketId: socket.id, reason }, 'Socket.IO disconnected');
    });
  });

  logger.info('Socket.IO server initialised');
  return io;
}

/**
 * Emit an event to a single user. No-op if the user has no active socket.
 * Never throws.
 */
export function emitToUser(userId: string, event: string, payload: unknown): void {
  if (!io) return;
  try {
    io.to(roomFor(userId)).emit(event, payload);
  } catch (err) {
    logger.warn({ err, userId, event }, 'Socket.IO emit failed');
  }
}

/** Emit to many users. No-op for users with no active socket. */
export function emitToUsers(userIds: readonly string[], event: string, payload: unknown): void {
  if (!io) return;
  for (const userId of userIds) emitToUser(userId, event, payload);
}

/** Expose the IO instance for shutdown. */
export function getIO(): SocketIOServer | null {
  return io;
}

/** Graceful shutdown — called from server.ts. */
export async function closeSocketIO(): Promise<void> {
  if (!io) return;
  await io.close();
  io = null;
  logger.info('Socket.IO closed');
}