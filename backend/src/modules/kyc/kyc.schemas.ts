/**
 * KYC module — request schemas.
 */

import { z } from 'zod';

const LegalNameSchema = z
  .string()
  .trim()
  .min(2, 'Legal name must be at least 2 characters')
  .max(200, 'Legal name is too long');

const BankNameSchema = z
  .string()
  .trim()
  .min(2, 'Bank name is required')
  .max(100, 'Bank name is too long');

const AccountNumberSchema = z
  .string()
  .trim()
  .regex(/^\d{6,12}$/, 'Account number must be 6-12 digits');

const SortCodeSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, ''))
  .refine((s) => /^\d{6}$/.test(s), 'Sort code must be 6 digits (e.g. 040004)');

export const SubmitKycSchema = z.object({
  legalName: LegalNameSchema,
  bankName: BankNameSchema,
  accountNumber: AccountNumberSchema,
  sortCode: SortCodeSchema,
});

export const RejectKycSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, 'Rejection reason must be at least 5 characters')
    .max(500, 'Reason is too long'),
});

export const ListKycQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
});

export type SubmitKycInput = z.infer<typeof SubmitKycSchema>;
export type RejectKycInput = z.infer<typeof RejectKycSchema>;
export type ListKycQueryInput = z.infer<typeof ListKycQuerySchema>;