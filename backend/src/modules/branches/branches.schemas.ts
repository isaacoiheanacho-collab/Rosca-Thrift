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
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Slug must be lowercase alphanumeric with dashes (no leading/trailing dash)');

const BranchNameSchema = z
  .string()
  .trim()
  .min(2, 'Branch name must be at least 2 characters')
  .max(120, 'Branch name is too long');

export const CreateBranchSchema = z.object({
  slug: SlugSchema,
  name: BranchNameSchema,
  contactEmail: z.string().trim().toLowerCase().email().optional(),
  contactPhone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/, 'Contact phone must be E.164 format')
    .optional(),
});

export const UpdateBranchSchema = z
  .object({
    name: BranchNameSchema.optional(),
    contactEmail: z.string().trim().toLowerCase().email().nullable().optional(),
    contactPhone: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{6,14}$/)
      .nullable()
      .optional(),
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

export type CreateBranchInput = z.infer<typeof CreateBranchSchema>;
export type UpdateBranchInput = z.infer<typeof UpdateBranchSchema>;
export type UpdateTrustAccountInput = z.infer<typeof UpdateTrustAccountSchema>;