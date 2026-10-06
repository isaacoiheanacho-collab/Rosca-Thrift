/**
 * Tenants module — request schemas.
 */

import { z } from 'zod';

export const ListTenantsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['FILLING', 'ACTIVE', 'COMPLETED', 'ARCHIVED']).optional(),
});

export const UpdateTenantStatusSchema = z.object({
  status: z.enum(['FILLING', 'ACTIVE', 'COMPLETED', 'ARCHIVED']),
});

export type ListTenantsQueryInput = z.infer<typeof ListTenantsQuerySchema>;
export type UpdateTenantStatusInput = z.infer<typeof UpdateTenantStatusSchema>;