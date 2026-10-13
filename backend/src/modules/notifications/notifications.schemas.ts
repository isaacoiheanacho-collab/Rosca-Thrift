/**
 * Notifications module — request schemas.
 */

import { z } from 'zod';

export const ListNotificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  unreadOnly: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => v === 'true' || v === true),
});

export const NotificationIdParamSchema = z.object({
  id: z.string().uuid('Invalid notification ID'),
});

export const PushSubscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(10).max(500),
    auth: z.string().min(10).max(500),
  }),
});

export const PushUnsubscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
});

export type ListNotificationsQueryInput = z.infer<typeof ListNotificationsQuerySchema>;
export type PushSubscribeInput = z.infer<typeof PushSubscribeSchema>;
export type PushUnsubscribeInput = z.infer<typeof PushUnsubscribeSchema>;