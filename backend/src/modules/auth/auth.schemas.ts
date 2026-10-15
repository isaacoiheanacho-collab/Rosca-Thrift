/**
 * Auth module — request schemas.
 *
 * Register requires explicit consent to Terms and Privacy. Both must be
 * accepted, and both must reference the current version strings.
 */

import { z } from 'zod';
import { CONSENT_VERSIONS } from '../consent/consent.constants';

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

const SlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(50)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Invalid branch slug');

const ConsentItemSchema = z.object({
  accepted: z.literal(true, {
    errorMap: () => ({ message: 'You must accept this document to continue' }),
  }),
  version: z.string().trim().min(1),
});

export const RegisterSchema = z.object({
  phone: PhoneSchema,
  password: PasswordSchema,
  fullName: FullNameSchema,
  branchSlug: SlugSchema.optional(),
  consents: z.object({
    terms: ConsentItemSchema,
    privacy: ConsentItemSchema,
  }),
});

export const VerifyPhoneSchema = z.object({
  phone: PhoneSchema,
  code: z.string().trim().regex(/^\d{6}$/, 'Code must be 6 digits'),
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
  code: z.string().trim().regex(/^\d{6}$/, 'Code must be 6 digits'),
  newPassword: PasswordSchema,
});

/**
 * Ensures the incoming version strings match the current platform versions.
 * If a client sends stale versions, they get a clear error telling them
 * to refresh the page and try again.
 */
export function assertCurrentVersions(consents: {
  terms: { version: string };
  privacy: { version: string };
}): void {
  if (consents.terms.version !== CONSENT_VERSIONS.TERMS) {
    throw new Error(
      `Terms version mismatch. Current: ${CONSENT_VERSIONS.TERMS}, got: ${consents.terms.version}. Refresh and try again.`,
    );
  }
  if (consents.privacy.version !== CONSENT_VERSIONS.PRIVACY) {
    throw new Error(
      `Privacy version mismatch. Current: ${CONSENT_VERSIONS.PRIVACY}, got: ${consents.privacy.version}. Refresh and try again.`,
    );
  }
}

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type VerifyPhoneInput = z.infer<typeof VerifyPhoneSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type RefreshInput = z.infer<typeof RefreshSchema>;
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;