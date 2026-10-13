/**
 * Web Push wrapper.
 *
 * Uses the `web-push` npm package with VAPID keys. VAPID is a standard
 * (RFC 8292) that lets a push service identify us as the sender without
 * any vendor (Firebase, etc.) — 100% free, 100% open.
 *
 * The public key is shared with the frontend, which passes it to
 * `pushManager.subscribe()` in the browser. The browser returns a
 * subscription object (endpoint + keys), which the frontend POSTs to
 * /api/notifications/push/subscribe.
 *
 * When we want to send a push:
 *   1. Look up all active subscriptions for the user
 *   2. Call sendWebPush(subscription, payload) for each
 *   3. If the push service says "410 Gone", mark the subscription revoked
 *
 * Failures are logged and swallowed — push is best-effort. The
 * notifications table is the source of truth.
 */

import webpush, { type PushSubscription, type WebPushError } from 'web-push';
import { env } from '../config/env';
import { logger } from '../logger';

let initialised = false;

export function ensureWebPushInitialised(): void {
  if (initialised) return;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    logger.warn('Web Push not configured (VAPID keys missing) — push disabled');
    return;
  }
  webpush.setVapidDetails(
    env.VAPID_SUBJECT,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY,
  );
  initialised = true;
  logger.info('Web Push initialised');
}

export interface PushPayload {
  title: string;
  body: string;
  /** Optional deep link / metadata the service worker can use. */
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface PushSendResult {
  ok: boolean;
  /** If the push service reports the subscription is gone, caller should mark it revoked. */
  gone?: boolean;
  error?: string;
}

/**
 * Send one push notification to a single subscription.
 * Never throws — always returns a result.
 */
export async function sendWebPush(
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: PushPayload,
): Promise<PushSendResult> {
  ensureWebPushInitialised();
  if (!initialised) {
    return { ok: false, error: 'Web Push not configured' };
  }

  const pushSub: PushSubscription = {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    },
  };

  const body = JSON.stringify(payload);

  try {
    await webpush.sendNotification(pushSub, body, {
      TTL: 60 * 60 * 24, // 24h — the push service will deliver when the device comes online
      urgency: 'normal',
    });
    return { ok: true };
  } catch (err) {
    const werr = err as WebPushError;
    const status = werr?.statusCode;
    // 404 / 410 = subscription no longer valid — the browser has revoked it
    if (status === 404 || status === 410) {
      return { ok: false, gone: true, error: `push_subscription_gone (${status})` };
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message, endpoint: subscription.endpoint.slice(0, 40) }, 'Web Push send failed');
    return { ok: false, error: message };
  }
}

/**
 * Return the public VAPID key. Frontend calls this to know what to pass
 * to pushManager.subscribe(). Safe to expose — it is a public key.
 */
export function getVapidPublicKey(): string | null {
  return env.VAPID_PUBLIC_KEY ?? null;
}