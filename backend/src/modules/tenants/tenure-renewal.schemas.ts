/**
 * Tenure renewal — request schemas.
 */

import { z } from 'zod';

export const CastRenewalVoteSchema = z.object({
  vote: z.enum(['YES', 'NO']),
});

export const TenantIdParamSchema = z.object({
  id: z.string().uuid('Invalid tenant ID'),
});

export const ReplacementBodySchema = z.object({
  /** The renewal row's slot number to fill. */
  slotNumber: z.coerce.number().int().min(1).max(12),
  /** The user being assigned as replacement. Must be verified, unassigned, same branch. */
  newUserId: z.string().uuid('Invalid user ID'),
});

export const ForceDissolveSchema = z.object({
  reason: z.string().trim().min(5).max(500),
});

export type CastRenewalVoteInput = z.infer<typeof CastRenewalVoteSchema>;
export type ReplacementBodyInput = z.infer<typeof ReplacementBodySchema>;
export type ForceDissolveInput = z.infer<typeof ForceDissolveSchema>;