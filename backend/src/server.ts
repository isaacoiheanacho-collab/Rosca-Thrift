import express, { type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import 'dotenv/config';

import { env } from './config/env';
import { logger } from './logger';
import { pool, testConnection } from './db';
import { requestId } from './middleware/requestId';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { generalLimiter, authLimiter } from './middleware/rateLimit';
import { authRoutes } from './modules';

const app = express();

// Trust proxy - required for correct IP behind Render / Cloudflare / etc.
app.set('trust proxy', 1);

// Security headers
app.use(helmet());

// CORS - explicit allowlist
app.use(
  cors({
    origin: env.CORS_ORIGINS_LIST,
    credentials: true,
  }),
);

// Body parsing
app.use(express.json({ limit: '1mb' }));

// Request ID + per-request logger
app.use(requestId);

// Global rate limit
app.use(generalLimiter);

// Lightweight access log
app.use((req: Request, res: Response, next) => {
  const start = Date.now();
  res.on('finish', () => {
    req.log.info(
      {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - start,
      },
      'request',
    );
  });
  next();
});

// Health check
app.get('/health', async (_req: Request, res: Response) => {
  const db = await testConnection();
  res.status(db.ok ? 200 : 503).json({
    ok: db.ok,
    service: 'rosca-backend',
    version: '0.1.0',
    time: new Date().toISOString(),
    database: db,
  });
});

// Root
app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'rosca-backend',
    message: 'ROSCA ledger API is running',
    health: '/health',
  });
});

// API routes - auth has its own stricter limiter
app.use('/api/auth', authLimiter, authRoutes);

// 404 + error handler - must be last
app.use(notFoundHandler);
app.use(errorHandler);

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down...');
  await pool.end();
  process.exit(0);
});

app.listen(env.PORT, () => {
  logger.info(`ROSCA backend listening on http://localhost:${env.PORT}`);
  logger.info(`Health check: http://localhost:${env.PORT}/health`);
});