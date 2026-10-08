/**
 * Receipts module — request schemas.
 */

import { z } from 'zod';

export const ReceiptIdParamSchema = z.object({
  id: z.string().uuid('Invalid receipt ID'),
});

export const IntentIdParamSchema = z.object({
  intentId: z.string().uuid('Invalid intent ID'),
});

export type ReceiptIdParam = z.infer<typeof ReceiptIdParamSchema>;
export type IntentIdParam = z.infer<typeof IntentIdParamSchema>;