/**
 * Users module — request schemas.
 */

import { z } from 'zod';

const PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'Phone must be in E.164 format (e.g. +447912345678)');

const FullNameSchema = z
  .string()
  .trim()
  .min(2, 'Full name must be at least 2 characters')
  .max(120, 'Full name is too long');

const EmailSchema = z.string().trim().toLowerCase().email('Invalid email address');

const PasswordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(72, 'Password must be at most 72 characters')
  .refine((p) => /[0-9]/.test(p), 'Password must contain at least one number')
  .refine((p) => /[^A-Za-z0-9]/.test(p), 'Password must contain at least one symbol');

const OtpCodeSchema = z.string().trim().regex(/^\d{6}$/, 'Code must be 6 digits');

export const UpdateProfileSchema = z
  .object({
    fullName: FullNameSchema.optional(),
    email: EmailSchema.nullable().optional(),
  })
  .refine((d) => d.fullName !== undefined || d.email !== undefined, {
    message: 'At least one field must be provided',
  });

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: PasswordSchema,
});

export const RequestPhoneChangeSchema = z.object({
  newPhone: PhoneSchema,
});

export const VerifyPhoneChangeSchema = z.object({
  newPhone: PhoneSchema,
  code: OtpCodeSchema,
});

export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;
export type RequestPhoneChangeInput = z.infer<typeof RequestPhoneChangeSchema>;
export type VerifyPhoneChangeInput = z.infer<typeof VerifyPhoneChangeSchema>;