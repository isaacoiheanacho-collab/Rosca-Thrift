import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requireBranchAdmin } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AppError } from '../../errors';
import { circleConfigurationsService } from './circle-configurations.service';

const CreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  contributionAmountPence: z.string().regex(/^[1-9][0-9]*$/),
  contributionFrequency: z.enum(['WEEKLY','MONTHLY']),
  memberCapacity: z.number().int().min(2).max(100),
  // Legacy clients may still send these; the service always derives canonical values.
  contributionWindowDays: z.number().int().min(1).max(90).optional(),
  cycleDurationDays: z.number().int().min(1).max(120).optional(),
});

export const publicCircleConfigurationsRouter = Router();
publicCircleConfigurationsRouter.get('/:branchSlug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await circleConfigurationsService.listPublic(String(req.params.branchSlug));
    res.json({ok:true,data});
  } catch (error) { next(error); }
});

export const branchAdminCircleConfigurationsRouter = Router();
branchAdminCircleConfigurationsRouter.use(requireBranchAdmin);
branchAdminCircleConfigurationsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const branchId = req.user!.branchId;
    if (!branchId) throw new AppError({code:'AUTH_BRANCH_REQUIRED',httpStatus:403,message:'No branch assigned to this account'});
    const data = await circleConfigurationsService.listForAdmin(branchId);
    res.json({ok:true,data});
  } catch (error) { next(error); }
});
branchAdminCircleConfigurationsRouter.post('/', validate({body:CreateSchema}), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const branchId = req.user!.branchId;
    if (!branchId) throw new AppError({code:'AUTH_BRANCH_REQUIRED',httpStatus:403,message:'No branch assigned to this account'});
    const data = await circleConfigurationsService.create(branchId, req.body, req.user!.sub);
    res.status(201).json({ok:true,data});
  } catch (error) { next(error); }
});
