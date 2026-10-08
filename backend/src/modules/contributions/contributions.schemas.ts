/**
 * Contributions module — request schemas.
 */

import { z } from 'zod';

/** Request a contribution intent for the current cycle. */
export const CreateIntentSchema = z.object({
  // No body — the cycle + tenant + user are inferred from the authenticated session.
});

/** Admin confirms a contribution after verifying the receipt. */
export const ConfirmContributionSchema = z.object({
  intentId: z.string().uuid('Invalid intent ID'),
  amount: z.coerce.number().int().positive('Amount must be a positive integer (pence)'),
  adminNote: z.string().trim().max(500).optional(),
});

/** Admin rejects a contribution receipt. */
export const RejectContributionSchema = z.object({
  intentId: z.string().uuid('Invalid intent ID'),
  reason: z.string().trim().min(5, 'Reason must be at least 5 characters').max(500),
});

/** Saver uploads a receipt. The file goes in the multipart body. */
export const UploadReceiptSchema = z.object({
  intentId: z.string().uuid('Invalid intent ID'),
  claimedAmount: z.coerce.number().int().positive('Amount must be a positive integer (pence)'),
  claimedReference: z.string().trim().min(1, 'Reference is required').max(50),
  claimedSenderName: z.string().trim().min(2, 'Sender name is required').max(200),
  claimedNote: z.string().trim().max(500).optional(),
});

/** Query params for listing pending contributions (admin). */
export const ListPendingSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  tenantId: z.string().uuid().optional(),
  cycle: z.coerce.number().int().min(1).max(12).optional(),
});

export type CreateIntentInput = z.infer<typeof CreateIntentSchema>;
export type ConfirmContributionInput = z.infer<typeof ConfirmContributionSchema>;
export type RejectContributionInput = z.infer<typeof RejectContributionSchema>;
export type UploadReceiptInput = z.infer<typeof UploadReceiptSchema>;
export type ListPendingInput = z.infer<typeof ListPendingSchema>;