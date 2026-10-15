/**
 * Consent repository — append-only access to user_consents.
 */

import type { PoolClient } from 'pg';
import { pool } from '../../db';
import type { ConsentType } from './consent.constants';

export interface UserConsentRow {
  id: string;
  user_id: string;
  consent_type: ConsentType;
  document_version: string;
  document_slug: string;
  accepted_at: Date;
  withdrawn_at: Date | null;
  withdrawal_reason: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date;
}

export class ConsentRepository {
  /** Insert one consent acceptance row. */
  async insertAcceptance(
    data: {
      userId: string;
      consentType: ConsentType;
      documentVersion: string;
      documentSlug: string;
      ipAddress: string | null;
      userAgent: string | null;
    },
    tx?: PoolClient,
  ): Promise<UserConsentRow> {
    const runner = tx ?? pool;
    const result = await runner.query<UserConsentRow>(
      `INSERT INTO user_consents
         (user_id, consent_type, document_version, document_slug, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        data.userId,
        data.consentType,
        data.documentVersion,
        data.documentSlug,
        data.ipAddress,
        data.userAgent,
      ],
    );
    return result.rows[0]!;
  }

  /** Mark the active consent of a given type as withdrawn. Returns the new row. */
  async insertWithdrawal(
    data: {
      userId: string;
      consentType: ConsentType;
      documentVersion: string;
      documentSlug: string;
      reason: string;
      ipAddress: string | null;
      userAgent: string | null;
    },
    tx?: PoolClient,
  ): Promise<UserConsentRow> {
    const runner = tx ?? pool;
    const result = await runner.query<UserConsentRow>(
      `INSERT INTO user_consents
         (user_id, consent_type, document_version, document_slug,
          accepted_at, withdrawn_at, withdrawal_reason, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, NOW(), NOW(), $5, $6, $7)
       RETURNING *`,
      [
        data.userId,
        data.consentType,
        data.documentVersion,
        data.documentSlug,
        data.reason,
        data.ipAddress,
        data.userAgent,
      ],
    );
    return result.rows[0]!;
  }

  /** True if the user has a currently-active acceptance of the given type. */
  async hasActive(
    userId: string,
    consentType: ConsentType,
  ): Promise<boolean> {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM user_consents
       WHERE user_id = $1 AND consent_type = $2 AND withdrawn_at IS NULL`,
      [userId, consentType],
    );
    return Number(result.rows[0]?.count ?? '0') > 0;
  }

  /** Full history for a user, newest first. */
  async listByUser(userId: string): Promise<UserConsentRow[]> {
    const result = await pool.query<UserConsentRow>(
      `SELECT * FROM user_consents
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows;
  }

  /** Latest row per consent type for a user, whether active or withdrawn. */
  async latestPerType(userId: string): Promise<UserConsentRow[]> {
    const result = await pool.query<UserConsentRow>(
      `SELECT DISTINCT ON (consent_type) *
       FROM user_consents
       WHERE user_id = $1
       ORDER BY consent_type, created_at DESC`,
      [userId],
    );
    return result.rows;
  }
}

export const consentRepository = new ConsentRepository();