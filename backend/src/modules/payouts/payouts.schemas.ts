/**
 * Payouts module — request schemas.
 */

import { z } from 'zod';

export const PayoutIdParamSchema = z.object({
  id: z.string().uuid('Invalid payout ID'),
});

export const FeeIntentIdParamSchema = z.object({
  id: z.string().uuid('Invalid fee intent ID'),
});

export const UploadFeeReceiptSchema = z.object({
  claimedAmount: z.coerce.number().int().positive('Amount must be a positive integer (pence)'),
  claimedReference: z.string().trim().min(1, 'Reference is required').max(50),
  claimedSenderName: z.string().trim().min(2, 'Sender name is required').max(200),
  claimedNote: z.string().trim().max(500).optional(),
  branchId: z.string().uuid().optional(),
});

export const UploadPayoutReceiptSchema = z.object({
  claimedAmount: z.coerce.number().int().positive('Amount must be a positive integer (pence)'),
  claimedReference: z.string().trim().min(1, 'Reference is required').max(50),
  claimedRecipientName: z.string().trim().min(2, 'Recipient name is required').max(200),
  claimedNote: z.string().trim().max(500).optional(),
  branchId: z.string().uuid().optional(),
});

export const ConfirmFeeSchema = z.object({
  adminNote: z.string().trim().max(500).optional(),
});

export const RejectFeeSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, 'Rejection reason must be at least 5 characters')
    .max(500, 'Reason is too long'),
});

export const FailPayoutSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, 'Failure reason must be at least 5 characters')
    .max(500, 'Reason is too long'),
  notes: z.string().trim().max(1000).optional(),
});

export const ListPayoutsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  state: z
    .enum(['PENDING', 'FEE_PAID', 'RECEIPT_UPLOADED', 'CONFIRMED', 'FAILED'])
    .optional(),
  branchId: z.string().uuid().optional(),
});

export const ListFeesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const ListFailedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  onlyUnretried: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => v === 'true' || v === true),
  branchId: z.string().uuid().optional(),
});

export const ConfirmPayoutQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
});

export type UploadFeeReceiptInput = z.infer<typeof UploadFeeReceiptSchema>;
export type UploadPayoutReceiptInput = z.infer<typeof UploadPayoutReceiptSchema>;
export type ConfirmFeeInput = z.infer<typeof ConfirmFeeSchema>;
export type RejectFeeInput = z.infer<typeof RejectFeeSchema>;
export type FailPayoutInput = z.infer<typeof FailPayoutSchema>;
export type ListPayoutsQueryInput = z.infer<typeof ListPayoutsQuerySchema>;
export type ListFeesQueryInput = z.infer<typeof ListFeesQuerySchema>;
export type ListFailedQueryInput = z.infer<typeof ListFailedQuerySchema>;