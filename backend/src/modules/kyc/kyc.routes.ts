/**
 * KYC routes.
 *
 * Saver:
 *   POST /api/kyc              - submit (multipart: selfie + fields)
 *   GET  /api/kyc/me           - view own status
 *
 * Branch Admin (their branch only):
 *   GET   /api/branch-admin/kyc                - list their branch's submissions
 *   GET   /api/branch-admin/kyc/:id            - view a submission
 *   PATCH /api/branch-admin/kyc/:id/approve    - approve
 *   PATCH /api/branch-admin/kyc/:id/reject     - reject with reason
 *
 * Super Admin (any branch):
 *   GET   /api/super-admin/kyc                 - list all
 *   GET   /api/super-admin/kyc/:id             - view any
 *   PATCH /api/super-admin/kyc/:id/approve     - approve
 *   PATCH /api/super-admin/kyc/:id/reject      - reject
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { requireAuth, requireSuperAdmin, requireBranchAdmin } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AppError, NotFoundError } from '../../errors';
import { kycService, type RequestMeta } from './kyc.service';
import { kycRepository } from './kyc.repository';
import { ListKycQuerySchema, RejectKycSchema, SubmitKycSchema } from './kyc.schemas';

function metaOf(req: Request): RequestMeta {
  return { ipAddress: req.ip, userAgent: req.header('user-agent') ?? undefined };
}

// ---- File upload config ----

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|heic)$/.test(file.mimetype);
    if (!ok) {
      cb(
        new AppError({
          code: 'KYC_BAD_FILE',
          httpStatus: 400,
          message: 'Selfie must be an image (JPEG/PNG/WebP/HEIC)',
        }),
      );
      return;
    }
    cb(null, true);
  },
});

// ---- Saver router ----

export const kycRouter = Router();

kycRouter.post(
  '/',
  requireAuth,
  upload.single('selfie'),
  validate({ body: SubmitKycSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        throw new AppError({
          code: 'KYC_NO_SELFIE',
          httpStatus: 400,
          message: 'Selfie file is required',
        });
      }
      const dto = await kycService.submit(
        req.user!.sub,
        req.body,
        {
          buffer: req.file.buffer,
          mimetype: req.file.mimetype,
          originalname: req.file.originalname,
        },
        metaOf(req),
      );
      res.status(201).json({ ok: true, data: dto });
    } catch (err) {
      next(err);
    }
  },
);

kycRouter.get('/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto = await kycService.getMine(req.user!.sub);
    res.json({ ok: true, data: dto });
  } catch (err) {
    next(err);
  }
});

// ---- Shared helper: verify branch access for a submission ----

async function assertCanAccessSubmission(
  submissionId: string,
  userBranchId: string | null,
  userRole: 'SUPER_ADMIN' | 'BRANCH_ADMIN' | 'SAVER',
): Promise<void> {
  const row = await kycRepository.findById(submissionId);
  if (!row) throw new NotFoundError('KYC submission');
  if (userRole === 'SUPER_ADMIN') return;
  if (userRole === 'BRANCH_ADMIN' && userBranchId === row.branch_id) return;
  throw new AppError({
    code: 'AUTH_BRANCH_SCOPE',
    httpStatus: 403,
    message: 'Not permitted for this branch',
  });
}

// ---- Branch Admin router ----

export const branchAdminKycRouter = Router();

branchAdminKycRouter.use(requireBranchAdmin);

branchAdminKycRouter.get(
  '/',
  validate({ query: ListKycQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as {
        limit: number;
        offset: number;
        status?: 'PENDING' | 'APPROVED' | 'REJECTED';
      };
      const user = req.user!;

      // Branch admin → only their branch. Super admin through this route → their own (null) → sees all if no branch filter. To keep simple: super admin using this route sees ALL.
      const branchFilter =
        user.role === 'BRANCH_ADMIN' ? user.branchId ?? '__none__' : undefined;

      const result = await kycService.list({
        limit: q.limit,
        offset: q.offset,
        status: q.status,
        branchId: branchFilter,
      });
      res.json({ ok: true, data: { ...result, limit: q.limit, offset: q.offset } });
    } catch (err) {
      next(err);
    }
  },
);

branchAdminKycRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    await assertCanAccessSubmission(id, req.user!.branchId, req.user!.role);
    const dto = await kycService.getById(id);
    res.json({ ok: true, data: dto });
  } catch (err) {
    next(err);
  }
});

branchAdminKycRouter.patch(
  '/:id/approve',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      await assertCanAccessSubmission(id, req.user!.branchId, req.user!.role);
      const dto = await kycService.approve(id, req.user!.sub, metaOf(req));
      res.json({ ok: true, data: dto });
    } catch (err) {
      next(err);
    }
  },
);

branchAdminKycRouter.patch(
  '/:id/reject',
  validate({ body: RejectKycSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      await assertCanAccessSubmission(id, req.user!.branchId, req.user!.role);
      const dto = await kycService.reject(id, req.user!.sub, req.body.reason, metaOf(req));
      res.json({ ok: true, data: dto });
    } catch (err) {
      next(err);
    }
  },
);

// ---- Super Admin router ----

export const superAdminKycRouter = Router();

superAdminKycRouter.use(requireSuperAdmin);

superAdminKycRouter.get(
  '/',
  validate({ query: ListKycQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as {
        limit: number;
        offset: number;
        status?: 'PENDING' | 'APPROVED' | 'REJECTED';
      };
      const result = await kycService.list({
        limit: q.limit,
        offset: q.offset,
        status: q.status,
      });
      res.json({ ok: true, data: { ...result, limit: q.limit, offset: q.offset } });
    } catch (err) {
      next(err);
    }
  },
);

superAdminKycRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto = await kycService.getById(String(req.params.id));
    res.json({ ok: true, data: dto });
  } catch (err) {
    next(err);
  }
});

superAdminKycRouter.patch('/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto = await kycService.approve(String(req.params.id), req.user!.sub, metaOf(req));
    res.json({ ok: true, data: dto });
  } catch (err) {
    next(err);
  }
});

superAdminKycRouter.patch(
  '/:id/reject',
  validate({ body: RejectKycSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dto = await kycService.reject(
        String(req.params.id),
        req.user!.sub,
        req.body.reason,
        metaOf(req),
      );
      res.json({ ok: true, data: dto });
    } catch (err) {
      next(err);
    }
  },
);