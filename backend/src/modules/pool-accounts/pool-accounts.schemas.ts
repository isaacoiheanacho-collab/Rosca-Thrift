/**
 * Pool accounts schemas.
 */

import { z } from 'zod';

const AccountHolderNameSchema = z.string().trim().min(2).max(200);
const BankNameSchema = z.string().trim().min(2).max(100);
const AccountNumberSchema = z.string().trim().regex(/^\d{6,12}$/, 'Account number must be 6-12 digits');
const SortCodeSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, ''))
  .refine((s) => /^\d{6}$/.test(s), 'Sort code must be 6 digits');

export const SetBranchPoolAccountSchema = z.object({
  accountHolderName: AccountHolderNameSchema,
  bankName: BankNameSchema,
  accountNumber: AccountNumberSchema,
  sortCode: SortCodeSchema,
  notes: z.string().trim().max(500).optional(),
});

export const SetPlatformMaintenanceAccountSchema = z.object({
  accountHolderName: AccountHolderNameSchema,
  bankName: BankNameSchema,
  accountNumber: AccountNumberSchema,
  sortCode: SortCodeSchema,
  notes: z.string().trim().max(500).optional(),
});

export type SetBranchPoolAccountInput = z.infer<typeof SetBranchPoolAccountSchema>;
export type SetPlatformMaintenanceAccountInput = z.infer<typeof SetPlatformMaintenanceAccountSchema>;