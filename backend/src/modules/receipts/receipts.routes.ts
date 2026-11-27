import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import { z } from 'zod';
import { pool } from '../../db';
import { AppError } from '../../errors/AppError';
import { deleteObject, getPresignedDownloadUrl, uploadObject } from '../../utils/s3';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();
const extensions: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!extensions[file.mimetype]) return callback(new AppError({ code: 'RECEIPT_TYPE_INVALID', httpStatus: 400, message: 'Receipt must be a PDF, JPEG or PNG file' }));
    callback(null, true);
  },
});
const asyncRoute = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };
const referenceSchema = z.object({
  contributionId: z.string().uuid().optional(),
  payoutId: z.string().uuid().optional(),
}).strict().refine((v) => Boolean(v.contributionId) !== Boolean(v.payoutId), 'Provide exactly one contributionId or payoutId');

async function assertReceiptAccess(
  reference: { contributionId?: string; payoutId?: string },
  userId: string,
  role: string,
) {
  const isSuper = role === 'SUPER_ADMIN';
  if (reference.contributionId) {
    const result = await pool.query(
      `SELECT t.branch_id FROM contributions c
       JOIN tenants t ON t.id = c.tenant_id
       WHERE c.id = $1 AND (
         EXISTS (SELECT 1 FROM tenant_members tm WHERE tm.id = c.tenant_member_id AND tm.user_id = $2)
         OR EXISTS (SELECT 1 FROM branch_admins ba WHERE ba.branch_id = t.branch_id AND ba.user_id = $2 AND ba.status = 'active')
         OR $3::boolean
       )`,
      [reference.contributionId, userId, isSuper],
    );
    if (!result.rowCount) throw new AppError({ code: 'RECEIPT_REFERENCE_FORBIDDEN', httpStatus: 404, message: 'Financial record not found or access denied' });
    return;
  }
  const result = await pool.query(
    `SELECT t.branch_id FROM payouts p
     JOIN payout_intents pi ON pi.id = p.payout_intent_id
     JOIN tenants t ON t.id = pi.tenant_id
     WHERE p.id = $1 AND (
       EXISTS (SELECT 1 FROM tenant_members tm WHERE tm.id = pi.recipient_member_id AND tm.user_id = $2)
       OR EXISTS (SELECT 1 FROM branch_admins ba WHERE ba.branch_id = t.branch_id AND ba.user_id = $2 AND ba.status = 'active')
       OR $3::boolean
     )`,
    [reference.payoutId, userId, isSuper],
  );
  if (!result.rowCount) throw new AppError({ code: 'RECEIPT_REFERENCE_FORBIDDEN', httpStatus: 404, message: 'Financial record not found or access denied' });
}

router.post('/', requireAuth, upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw new AppError({ code: 'RECEIPT_FILE_REQUIRED', httpStatus: 400, message: 'Attach a receipt file' });
  const reference = referenceSchema.parse({
    contributionId: req.body.contributionId,
    payoutId: req.body.payoutId,
  });
  await assertReceiptAccess(reference, req.auth!.userId, req.auth!.role);
  const key = `receipts/${req.auth!.userId}/${randomUUID()}.${extensions[req.file.mimetype]}`;
  await uploadObject(key, req.file.buffer, req.file.mimetype);
  try {
    const result = await pool.query(
      `INSERT INTO receipts (contribution_id, payout_id, storage_key, content_type, uploaded_by_user_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, contribution_id, payout_id, content_type, created_at`,
      [reference.contributionId ?? null, reference.payoutId ?? null, key, req.file.mimetype, req.auth!.userId],
    );
    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (error) {
    await deleteObject(key).catch(() => undefined);
    throw error;
  }
}));

router.get('/:receiptId', requireAuth, asyncRoute(async (req, res) => {
  const receiptId = z.string().uuid().parse(req.params.receiptId);
  const result = await pool.query<{id:string;storage_key:string;contribution_id:string|null;payout_id:string|null}>(
    'SELECT id, storage_key, contribution_id, payout_id FROM receipts WHERE id = $1',
    [receiptId],
  );
  const receipt = result.rows[0];
  if (!receipt) throw new AppError({ code: 'RECEIPT_NOT_FOUND', httpStatus: 404, message: 'Receipt not found' });
  await assertReceiptAccess({ contributionId: receipt.contribution_id ?? undefined, payoutId: receipt.payout_id ?? undefined }, req.auth!.userId, req.auth!.role);
  res.json({ ok: true, data: { id: receipt.id, downloadUrl: await getPresignedDownloadUrl(receipt.storage_key, 300) } });
}));

export { router as receiptsRoutes };
