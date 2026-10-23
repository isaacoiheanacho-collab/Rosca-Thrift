/**
 * Branches module — request schemas.
 */

import { z } from 'zod';

const SlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Slug must be at least 3 characters')
  .max(50, 'Slug is too long')
  .regex(
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
    'Slug must be lowercase alphanumeric with dashes (no leading/trailing dash)',
  );

const BranchNameSchema = z
  .string()
  .trim()
  .min(2, 'Branch name must be at least 2 characters')
  .max(120, 'Branch name is too long');

const HexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a hex code like #00daf3');

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

export const CreateBranchSchema = z.object({
  slug: SlugSchema,
  name: BranchNameSchema,
  contactEmail: z.string().trim().toLowerCase().email().optional(),
  contactPhone: PhoneSchema.optional(),
});

export const UpdateBranchSchema = z
  .object({
    name: BranchNameSchema.optional(),
    contactEmail: z.string().trim().toLowerCase().email().nullable().optional(),
    contactPhone: PhoneSchema.nullable().optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED']).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: 'At least one field must be provided',
  });

export const UpdateTrustAccountSchema = z.object({
  trustAccountName: z.string().trim().min(2, 'Trust account name is required'),
  trustAccountSort: z
    .string()
    .trim()
    .transform((s) => s.replace(/[\s-]/g, ''))
    .refine((s) => /^\d{6}$/.test(s), 'Sort code must be 6 digits'),
  trustAccountNumber: z
    .string()
    .trim()
    .regex(/^\d{6,12}$/, 'Account number must be 6-12 digits'),
  trustAccountHolder: z.string().trim().min(2, 'Account holder name is required'),
});

export const UpdateBrandingSchema = z
  .object({
    logoUrl: z.string().trim().url('Logo must be a valid URL').optional(),
    primaryColor: HexColorSchema.optional(),
    accentColor: HexColorSchema.optional(),
    displayName: z.string().trim().min(2).max(120).optional(),
    contactEmail: z.string().trim().toLowerCase().email().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: 'At least one branding field must be provided',
  });

export const UpdateBranchContentSchema = z
  .object({
    aboutText: z.string().trim().max(5000).nullable().optional(),
    branchTerms: z.string().trim().max(50000).nullable().optional(),
    branchPrivacy: z.string().trim().max(50000).nullable().optional(),
    branchTermsVersion: z.string().trim().min(1).max(20).optional(),
    branchPrivacyVersion: z.string().trim().min(1).max(20).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: 'At least one field must be provided',
  });

/**
 * Onboarding: public self-serve form.
 * Creates a PENDING branch + a BRANCH_ADMIN user.
 * Both platform Terms and Privacy must be accepted.
 */
export const OnboardBranchSchema = z.object({
  branch: z.object({
    slug: SlugSchema,
    name: BranchNameSchema,
    contactEmail: z.string().trim().toLowerCase().email(),
    contactPhone: PhoneSchema.optional(),
    note: z.string().trim().max(2000).optional(),
  }),
  admin: z.object({
    fullName: FullNameSchema,
    phone: PhoneSchema,
    password: PasswordSchema,
  }),
  consents: z.object({
    terms: z.object({
      accepted: z.literal(true, {
        errorMap: () => ({ message: 'You must accept the Terms of Service' }),
      }),
      version: z.string().trim().min(1),
    }),
    privacy: z.object({
      accepted: z.literal(true, {
        errorMap: () => ({ message: 'You must accept the Privacy Policy' }),
      }),
      version: z.string().trim().min(1),
    }),
  }),
});

export const RejectOnboardingSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, 'Rejection reason must be at least 5 characters')
    .max(500, 'Reason is too long'),
});

export type CreateBranchInput = z.infer<typeof CreateBranchSchema>;
export type UpdateBranchInput = z.infer<typeof UpdateBranchSchema>;
export type UpdateTrustAccountInput = z.infer<typeof UpdateTrustAccountSchema>;
export type UpdateBrandingInput = z.infer<typeof UpdateBrandingSchema>;
export type UpdateBranchContentInput = z.infer<typeof UpdateBranchContentSchema>;
export type OnboardBranchInput = z.infer<typeof OnboardBranchSchema>;
export type RejectOnboardingInput = z.infer<typeof RejectOnboardingSchema>;