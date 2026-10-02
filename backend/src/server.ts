import express, { type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import 'dotenv/config';

import { env } from './config/env';
import { logger } from './logger';
import { pool, testConnection } from './db';
import { redis, testRedis, closeRedis } from './utils/redis';
import { startAllWorkers, stopAllWorkers } from './queue';
import { requestId } from './middleware/requestId';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { generalLimiter, authLimiter } from './middleware/rateLimit';
import { authRoutes } from './modules';

const app = express();

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGINS_LIST, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(requestId);
app.use(generalLimiter);

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

app.get('/health', async (_req: Request, res: Response) => {
  const [db, cache] = await Promise.all([testConnection(), testRedis()]);
  const ok = db.ok && cache.ok;
  res.status(ok ? 200 : 503).json({
    ok,
    service: 'rosca-backend',
    version: '0.1.0',
    time: new Date().toISOString(),
    database: db,
    redis: cache,
  });
});

app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'rosca-backend',
    message: 'ROSCA ledger API is running',
    health: '/health',
  });
});

app.use('/api/auth', authLimiter, authRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down...`);
  await Promise.allSettled([stopAllWorkers(), pool.end(), closeRedis()]);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

app.listen(env.PORT, () => {
  logger.info(`ROSCA backend listening on http://localhost:${env.PORT}`);
  logger.info(`Health check: http://localhost:${env.PORT}/health`);
  startAllWorkers();
});

void redis;