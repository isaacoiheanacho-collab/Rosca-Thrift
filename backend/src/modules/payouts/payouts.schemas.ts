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
  // Super admin must supply branchId (either here, or in query)
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

export const ListPayoutsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  state: z.enum(['PENDING', 'FEE_PAID', 'RECEIPT_UPLOADED', 'CONFIRMED']).optional(),
  // Super admin must supply branchId here
  branchId: z.string().uuid().optional(),
});

export const ListFeesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const ConfirmPayoutQuerySchema = z.object({
  // Super admin must supply branchId here
  branchId: z.string().uuid().optional(),
});

export type UploadFeeReceiptInput = z.infer<typeof UploadFeeReceiptSchema>;
export type UploadPayoutReceiptInput = z.infer<typeof UploadPayoutReceiptSchema>;
export type ConfirmFeeInput = z.infer<typeof ConfirmFeeSchema>;
export type ListPayoutsQueryInput = z.infer<typeof ListPayoutsQuerySchema>;
export type ListFeesQueryInput = z.infer<typeof ListFeesQuerySchema>;