/**
 * Receipts repository — read-only queries on the receipts table.
 * Receipt writes go through the contributions service (which needs to
 * upload to B2 first).
 */

import { pool } from '../../db';
import type { ReceiptRow } from '../contributions/contributions.repository';

export class ReceiptsRepository {
  async findById(id: string): Promise<ReceiptRow | null> {
    const result = await pool.query<ReceiptRow>('SELECT * FROM receipts WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  async listByIntent(intentId: string): Promise<ReceiptRow[]> {
    const result = await pool.query<ReceiptRow>(
      `SELECT * FROM receipts WHERE intent_id = $1 ORDER BY created_at DESC`,
      [intentId],
    );
    return result.rows;
  }

  async listByTenant(tenantId: string, limit = 100): Promise<ReceiptRow[]> {
    const result = await pool.query<ReceiptRow>(
      `SELECT r.* FROM receipts r
       INNER JOIN contribution_intents i ON i.id = r.intent_id
       WHERE i.tenant_id = $1
       ORDER BY r.created_at DESC
       LIMIT $2`,
      [tenantId, limit],
    );
    return result.rows;
  }
}

export const receiptsRepository = new ReceiptsRepository();