/**
 * SMS delivery via textbee.dev.
 *
 * In development, SMS is skipped for test phone numbers:
 *   - +447700*  (test prefix)
 *   - +447800*
 *   - +447900*
 *
 * This lets us run automated tests without consuming the daily SMS quota.
 * Real customer numbers in production still go through textbee.
 */

import { env } from '../config/env';
import { logger } from '../logger';

export interface SendSmsResult {
  ok: boolean;
  smsBatchId?: string;
  error?: string;
}

interface TextbeeResponse {
  data?: {
    success?: boolean;
    message?: string;
    smsBatchId?: string;
  };
}

const TEST_PHONE_PREFIXES = ['+447700', '+447800', '+447900'];

function isTestPhone(phone: string): boolean {
  return TEST_PHONE_PREFIXES.some((p) => phone.startsWith(p));
}

export async function sendSms(to: string, message: string): Promise<SendSmsResult> {
  if (!/^\+[1-9]\d{6,14}$/.test(to)) {
    return { ok: false, error: `Invalid E.164 phone: ${to}` };
  }

  // In development, skip real SMS for test phone numbers
  if (env.IS_DEVELOPMENT && isTestPhone(to)) {
    logger.info(
      { to, preview: message.slice(0, 40) + '...' },
      'SMS: DEV mode — skipping send for test phone (no textbee call)',
    );
    return { ok: true, smsBatchId: 'dev-skipped' };
  }

  const url = `${env.TEXTBEE_BASE_URL}/gateway/send-sms`;
  const body = {
    deviceId: env.TEXTBEE_DEVICE_ID,
    recipients: [to],
    message,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': env.TEXTBEE_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const json = (await res.json().catch(() => ({}))) as TextbeeResponse;

    if (!res.ok) {
      logger.error({ status: res.status, to, json }, 'textbee: send failed');
      return { ok: false, error: `textbee HTTP ${res.status}` };
    }

    if (!json.data?.success) {
      logger.error({ to, json }, 'textbee: response not successful');
      return { ok: false, error: json.data?.message ?? 'Unknown textbee error' };
    }

    logger.info({ to, smsBatchId: json.data.smsBatchId }, 'SMS sent');
    return { ok: true, smsBatchId: json.data.smsBatchId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, to }, 'textbee: request failed');
    return { ok: false, error: message };
  }
}