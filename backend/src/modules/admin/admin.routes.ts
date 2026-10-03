/**
 * Admin routes — user management. All routes require ADMIN role.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { usersRepository } from '../users/users.repository';
import { toPublicUser } from '../users/users.service';
import { NotFoundError } from '../../errors';
import { record } from '../audit/audit.service';

const router = Router();

const ListUsersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['PENDING', 'VERIFIED', 'SUSPENDED']).optional(),
  role: z.enum(['SAVER', 'ADMIN']).optional(),
  search: z.string().trim().min(1).max(100).optional(),
});

const UpdateStatusSchema = z.object({
  status: z.enum(['PENDING', 'VERIFIED', 'SUSPENDED']),
});

router.use(requireAdmin);

router.get(
  '/users',
  validate({ query: ListUsersQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as z.infer<typeof ListUsersQuerySchema>;

      const result = await usersRepository.listUsers({
        limit: q.limit,
        offset: q.offset,
        status: q.status,
        role: q.role,
        search: q.search,
      });

      res.json({
        ok: true,
        data: {
          users: result.users.map(toPublicUser),
          total: result.total,
          limit: q.limit,
          offset: q.offset,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get('/users/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await usersRepository.findById(String(req.params.id));

    if (!user) {
      throw new NotFoundError('User');
    }

    res.json({ ok: true, data: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/users/:id/status',
  validate({ body: UpdateStatusSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await usersRepository.findById(String(req.params.id));

      if (!existing) {
        throw new NotFoundError('User');
      }

      const updated = await usersRepository.updateUserStatus(
        String(req.params.id),
        req.body.status,
      );

      await record({
        actorId: req.user!.sub,
        action: 'USER_STATUS_CHANGED',
        entityType: 'user',
        entityId: String(req.params.id),
        ipAddress: req.ip,
        userAgent: req.header('user-agent') ?? undefined,
        metadata: { from: existing.status, to: req.body.status },
      });

      res.json({ ok: true, data: toPublicUser(updated) });
    } catch (err) {
      next(err);
    }
  },
);

export default router;