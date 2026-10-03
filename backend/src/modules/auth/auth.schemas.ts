/**
 * Auth schemas - phone-first.
 *
 * Registration is phone + password. Email is optional (kept for future use).
 * OTP is sent automatically on register; user must verify before login works.
 */

import { z } from 'zod';

const PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'Phone must be in E.164 format (e.g. +447912345678)');

const PasswordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(72, 'Password must be at most 72 characters')
  .refine((p) => /[0-9]/.test(p), 'Password must contain at least one number')
  .refine((p) => /[^A-Za-z0-9]/.test(p), 'Password must contain at least one symbol');

const FullNameSchema = z
  .string()
  .trim()
  .min(2, 'Full name must be at least 2 characters')
  .max(120, 'Full name is too long');

const EmailSchema = z.string().trim().toLowerCase().email('Invalid email address');

const OtpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Code must be 6 digits');

export const RegisterSchema = z.object({
  phone: PhoneSchema,
  password: PasswordSchema,
  fullName: FullNameSchema,
  email: EmailSchema.optional(),
});

export const VerifyPhoneSchema = z.object({
  phone: PhoneSchema,
  code: OtpCodeSchema,
});

export const LoginSchema = z.object({
  phone: PhoneSchema,
  password: z.string().min(1, 'Password is required'),
});

export const RefreshSchema = z.object({
  refreshToken: z.string().min(20, 'Refresh token is required'),
});

export const ForgotPasswordSchema = z.object({
  phone: PhoneSchema,
});

export const ResetPasswordSchema = z.object({
  phone: PhoneSchema,
  code: OtpCodeSchema,
  newPassword: PasswordSchema,
});

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type VerifyPhoneInput = z.infer<typeof VerifyPhoneSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type RefreshInput = z.infer<typeof RefreshSchema>;
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;