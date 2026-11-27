import { z } from 'zod';

export const requestOtpSchema = z.object({
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Phone must be in E.164 format'),
}).strict();

export const verifyOtpSchema = z.object({
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/),
  code: z.string().regex(/^\d{6}$/, 'OTP must contain six digits'),
}).strict();

export const refreshSchema = z.object({
  refreshToken: z.string().min(32).max(4096),
}).strict();

export const logoutSchema = refreshSchema;

export type RequestOtpInput = z.infer<typeof requestOtpSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
