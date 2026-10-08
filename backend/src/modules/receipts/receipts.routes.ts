/**
 * Receipts routes — read-only access to uploaded receipts.
 *
 * Saver:
 *   GET /api/receipts/:id          - view own receipt (must own the receipt)
 *
 * Anyone in the tenant:
 *   GET /api/receipts/intent/:intentId  - list receipts for an intent (tenant-scoped)
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AppError } from '../../errors';
import { receiptsService } from './receipts.service';
import { contributionsRepository } from '../contributions/contributions.repository';
import { tenantsRepository } from '../tenants/tenants.repository';
import { ReceiptIdParamSchema, IntentIdParamSchema } from './receipts.schemas';

const router = Router();

router.use(requireAuth);

router.get(
  '/:id',
  validate({ params: ReceiptIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const receipt = await receiptsService.getById(String(req.params.id));

      // Access: uploader OR same-branch tenant member
      const user = req.user!;
      if (receipt.uploadedBy !== user.sub) {
        if (!user.branchId) throw new AppError({ code: 'AUTH_FORBIDDEN', httpStatus: 403, message: 'Not permitted' });

        const intent = receipt.intentId
          ? await contributionsRepository.findIntentById(receipt.intentId)
          : null;
        if (!intent || intent.branch_id !== user.branchId) {
          throw new AppError({
            code: 'AUTH_BRANCH_SCOPE',
            httpStatus: 403,
            message: 'Not permitted for this receipt',
          });
        }
      }

      res.json({ ok: true, data: receipt });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/intent/:intentId',
  validate({ params: IntentIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const intentId = String(req.params.intentId);
      const intent = await contributionsRepository.findIntentById(intentId);
      if (!intent) {
        throw new AppError({ code: 'NOT_FOUND', httpStatus: 404, message: 'Intent not found' });
      }

      // Access: any member of the same tenant
      const membership = await tenantsRepository.findMembershipByUser(req.user!.sub);
      if (!membership || membership.tenant_id !== intent.tenant_id) {
        throw new AppError({
          code: 'AUTH_TENANT_SCOPE',
          httpStatus: 403,
          message: 'Not permitted for this tenant',
        });
      }

      const receipts = await receiptsService.listByIntent(intentId);
      res.json({ ok: true, data: receipts });
    } catch (err) {
      next(err);
    }
  },
);

export default router;