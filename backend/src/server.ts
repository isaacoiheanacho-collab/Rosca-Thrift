import express, { type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import 'dotenv/config';

import { env } from './config/env';
import { logger } from './logger';
import { pool, testConnection } from './db';
import { redis, testRedis, closeRedis } from './utils/redis';
import { testS3 } from './utils/s3';
import { startAllWorkers, stopAllWorkers } from './queue';
import { requestId } from './middleware/requestId';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { generalLimiter, authLimiter } from './middleware/rateLimit';
import {
  authRoutes,
  usersRoutes,
  publicBranchesRouter,
  superAdminBranchesRouter,
  branchTrustAccountRouter,
  kycRouter,
  branchAdminKycRouter,
  superAdminKycRouter,
  tenantsRouter,
  branchAdminTenantsRouter,
  superAdminTenantsRouter,
} from './modules';

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
  const [db, cache, storage] = await Promise.all([testConnection(), testRedis(), testS3()]);
  const ok = db.ok && cache.ok && storage.ok;
  res.status(ok ? 200 : 503).json({
    ok,
    service: 'rosca-backend',
    version: '0.1.0',
    time: new Date().toISOString(),
    database: db,
    redis: cache,
    storage,
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
app.use('/api/users', usersRoutes);
app.use('/api/branches', publicBranchesRouter);
app.use('/api/branches', branchTrustAccountRouter);
app.use('/api/super-admin/branches', superAdminBranchesRouter);
app.use('/api/kyc', kycRouter);
app.use('/api/branch-admin/kyc', branchAdminKycRouter);
app.use('/api/super-admin/kyc', superAdminKycRouter);
app.use('/api/tenants', tenantsRouter);
app.use('/api/branch-admin/tenants', branchAdminTenantsRouter);
app.use('/api/super-admin/tenants', superAdminTenantsRouter);

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

  void (async () => {
    if (!env.SUPER_ADMIN_PHONE) return;
    try {
      await pool.query(
        `UPDATE users SET role = 'SUPER_ADMIN', branch_id = NULL
         WHERE phone = $1 AND role != 'SUPER_ADMIN'`,
        [env.SUPER_ADMIN_PHONE],
      );
      logger.info({ superAdminPhone: env.SUPER_ADMIN_PHONE }, 'Super admin bootstrap checked');
    } catch (err) {
      logger.error({ err }, 'Super admin bootstrap failed');
    }
  })();
});

void redis;