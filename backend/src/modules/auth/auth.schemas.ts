/**
 * Auth module — request schemas.
 *
 * These are the only shapes the auth endpoints accept. Anything else
 * is rejected before it reaches the service layer.
 */

import { z } from 'zod';

const PasswordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(72, 'Password must be at most 72 characters') // bcrypt truncates at 72 bytes
  .refine((p) => /[0-9]/.test(p), 'Password must contain at least one number')
  .refine((p) => /[^A-Za-z0-9]/.test(p), 'Password must contain at least one symbol');

const EmailSchema = z.string().trim().toLowerCase().email('Invalid email address');
const PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[1-9]\d{6,14}$/, 'Invalid phone number (E.164 format expected)');

const FullNameSchema = z
  .string()
  .trim()
  .min(2, 'Full name must be at least 2 characters')
  .max(120, 'Full name is too long');

export const RegisterSchema = z
  .object({
    email: EmailSchema.optional(),
    phone: PhoneSchema.optional(),
    password: PasswordSchema,
    fullName: FullNameSchema,
  })
  .refine((d) => d.email || d.phone, {
    message: 'Either email or phone is required',
    path: ['email'],
  });

export const LoginSchema = z
  .object({
    email: EmailSchema.optional(),
    phone: PhoneSchema.optional(),
    password: z.string().min(1, 'Password is required'),
  })
  .refine((d) => d.email || d.phone, {
    message: 'Either email or phone is required',
    path: ['email'],
  });

export const RefreshSchema = z.object({
  refreshToken: z.string().min(20, 'Refresh token is required'),
});

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type RefreshInput = z.infer<typeof RefreshSchema>;