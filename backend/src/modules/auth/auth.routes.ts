import { Router, type Request, type Response, type NextFunction } from 'express';
import { requestOtpSchema, verifyOtpSchema, refreshSchema, logoutSchema } from './auth.schemas';
import * as service from './auth.service';
import { requireAuth } from './auth.middleware';

const router = Router();
const asyncRoute = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

router.post('/otp/request', asyncRoute(async (req, res) => {
  const body = requestOtpSchema.parse(req.body);
  res.status(202).json({ ok: true, data: await service.requestOtp(body.phone) });
}));

router.post('/otp/verify', asyncRoute(async (req, res) => {
  const body = verifyOtpSchema.parse(req.body);
  const data = await service.verifyOtp(body, {
    userAgent: req.header('user-agent') ?? null,
    ipAddress: req.ip ?? null,
  });
  res.status(200).json({ ok: true, data });
}));

router.post('/refresh', asyncRoute(async (req, res) => {
  const body = refreshSchema.parse(req.body);
  res.json({ ok: true, data: await service.refreshSession(body.refreshToken) });
}));

router.post('/logout', asyncRoute(async (req, res) => {
  const body = logoutSchema.parse(req.body);
  await service.logout(body.refreshToken);
  res.json({ ok: true, data: { message: 'Session revoked' } });
}));

router.get('/me', requireAuth, asyncRoute(async (req, res) => {
  res.json({ ok: true, data: await service.getProfile(req.auth!.userId) });
}));

export { router as authRoutes };
