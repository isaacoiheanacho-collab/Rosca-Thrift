/**
 * Consent service — records acceptances, checks state, enforces withdrawal
 * preconditions.
 *
 * Withdrawal rule:
 *   Consent can ONLY be withdrawn when the user has no active tenant
 *   membership. This prevents a member walking away mid-tenure — especially
 *   after receiving a payout.
 */

import { pool } from '../../db';
import { logger } from '../../logger';
import { AppError } from '../../errors';
import { record } from '../audit/audit.service';
import {
  CONSENT_TYPES,
  type ConsentType,
} from './consent.constants';
import {
  consentRepository,
  type UserConsentRow,
} from './consent.repository';

export interface RecordConsentInput {
  userId: string;
  consentType: ConsentType;
  documentVersion: string;
  documentSlug: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface CanWithdrawResult {
  allowed: boolean;
  reason?: string;
  activeTenantId?: string | null;
}

export class ConsentService {
  /**
   * Record one acceptance. Used at register and when a user re-consents.
   */
  async recordAcceptance(input: RecordConsentInput): Promise<UserConsentRow> {
    const row = await consentRepository.insertAcceptance({
      userId: input.userId,
      consentType: input.consentType,
      documentVersion: input.documentVersion,
      documentSlug: input.documentSlug,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });

    logger.info(
      {
        userId: input.userId,
        consentType: input.consentType,
        version: input.documentVersion,
      },
      'Consent accepted',
    );

    return row;
  }

  /**
   * Record several acceptances in a batch (typically at register).
   * Not transactional across rows — if any fails, the caller decides what to do.
   */
  async recordMany(inputs: RecordConsentInput[]): Promise<UserConsentRow[]> {
    const rows: UserConsentRow[] = [];
    for (const input of inputs) {
      rows.push(await this.recordAcceptance(input));
    }
    return rows;
  }

  async hasActive(userId: string, consentType: ConsentType): Promise<boolean> {
    return consentRepository.hasActive(userId, consentType);
  }

  async listForUser(userId: string): Promise<UserConsentRow[]> {
    return consentRepository.listByUser(userId);
  }

  async latestForUser(userId: string): Promise<UserConsentRow[]> {
    return consentRepository.latestPerType(userId);
  }

  /**
   * Check whether the user is currently allowed to withdraw consent.
   * Rule: no active tenant membership.
   */
  async canWithdraw(userId: string): Promise<CanWithdrawResult> {
    const result = await pool.query<{
      tenant_id: string;
      status: string;
    }>(
      `SELECT tm.tenant_id, t.status
       FROM tenant_memberships tm
       INNER JOIN tenants t ON t.id = tm.tenant_id
       WHERE tm.user_id = $1 AND tm.status = 'ACTIVE'
       LIMIT 1`,
      [userId],
    );

    const row = result.rows[0];
    if (!row) {
      return { allowed: true };
    }

    // If the tenant is ACTIVE, they're inside a running circle.
    if (row.status === 'ACTIVE') {
      return {
        allowed: false,
        reason:
          'You cannot withdraw consent while your circle is running. ' +
          'You can withdraw at the end of your 12-month tenure, ' +
          'or by declining renewal when the vote opens.',
        activeTenantId: row.tenant_id,
      };
    }

    // FILLING, COMPLETED, ARCHIVED — treat as no active tenure.
    return { allowed: true };
  }

  /**
   * Withdraw consent. Throws if the user is inside an active tenure.
   */
  async withdraw(params: {
    userId: string;
    consentType: ConsentType;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<UserConsentRow> {
    const check = await this.canWithdraw(params.userId);
    if (!check.allowed) {
      throw new AppError({
        code: 'CONSENT_WITHDRAWAL_LOCKED',
        httpStatus: 403,
        message: check.reason ?? 'Withdrawal is not allowed right now',
      });
    }

    // Find the current active row to copy its version + slug
    const latest = await consentRepository.latestPerType(params.userId);
    const active = latest.find(
      (r) => r.consent_type === params.consentType && r.withdrawn_at === null,
    );

    if (!active) {
      throw new AppError({
        code: 'CONSENT_NOT_ACTIVE',
        httpStatus: 409,
        message: `No active ${params.consentType} consent to withdraw`,
      });
    }

    const row = await consentRepository.insertWithdrawal({
      userId: params.userId,
      consentType: params.consentType,
      documentVersion: active.document_version,
      documentSlug: active.document_slug,
      reason: 'user_requested',
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
    });

    await record({
      actorId: params.userId,
      action: 'CONSENT_WITHDRAWN',
      entityType: 'user_consent',
      entityId: row.id,
      ipAddress: params.ipAddress ?? undefined,
      userAgent: params.userAgent ?? undefined,
      metadata: {
        consentType: params.consentType,
        version: active.document_version,
      },
    });

    logger.warn(
      { userId: params.userId, consentType: params.consentType },
      'Consent withdrawn by user',
    );

    return row;
  }
}

export const consentService = new ConsentService();
void CONSENT_TYPES;