/**
 * Stats repository — read-only aggregation queries.
 *
 * All queries are cheap (indexed) aggregates on existing tables.
 * No writes. No new schema. No migrations.
 */

import { pool } from '../../db';

export interface PlatformCounts {
  branchesTotal: number;
  branchesActive: number;
  branchesSuspended: number;
  branchesArchived: number;

  tenantsFilling: number;
  tenantsActive: number;
  tenantsCompleted: number;
  tenantsArchived: number;
  tenantsTotal: number;

  membersTotal: number;
  kycPending: number;
  kycApproved: number;
  kycRejected: number;

  renewalsInVoting: number;
  renewalsInReplacing: number;
  renewalsRenewed: number;
}

export interface MoneyThisMonth {
  contributionsThisMonthPence: bigint;
  contributionsThisMonthCount: number;
  contributionsPendingConfirmation: number;

  payoutsThisMonthPence: bigint;
  payoutsThisMonthCount: number;
  payoutsPendingFees: number;
  payoutsPendingConfirmation: number;
}

export interface BranchCounts {
  tenantsFilling: number;
  tenantsActive: number;
  tenantsCompleted: number;
  tenantsArchived: number;
  tenantsTotal: number;

  membersTotal: number;
  kycPending: number;
  kycApproved: number;
  kycRejected: number;

  renewalsInVoting: number;
  renewalsInReplacing: number;
  renewalsRenewed: number;
}

export interface BranchMoneyThisMonth {
  contributionsThisMonthPence: bigint;
  contributionsThisMonthCount: number;
  contributionsPendingConfirmation: number;

  payoutsThisMonthPence: bigint;
  payoutsThisMonthCount: number;
  payoutsPendingFees: number;
  payoutsPendingConfirmation: number;
}

export interface MonthlyVolumeRow {
  month: string; // 'YYYY-MM'
  contributionsPence: bigint;
  contributionsCount: number;
  payoutsPence: bigint;
  payoutsCount: number;
}

export class StatsRepository {
  // ─────────────────────────────────────────────────────────────
  // Platform-wide
  // ─────────────────────────────────────────────────────────────

  async platformCounts(): Promise<PlatformCounts> {
    const [
      branchStatus,
      tenantStatus,
      userCounts,
      kycCounts,
      renewalCounts,
    ] = await Promise.all([
      pool.query<{ status: string; count: string }>(
        `SELECT status, COUNT(*)::text AS count FROM branches GROUP BY status`,
      ),
      pool.query<{ status: string; count: string }>(
        `SELECT status, COUNT(*)::text AS count FROM tenants GROUP BY status`,
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM users WHERE role = 'SAVER'`,
      ),
      pool.query<{ status: string; count: string }>(
        `SELECT status, COUNT(*)::text AS count FROM kyc_submissions GROUP BY status`,
      ),
      pool.query<{ renewal_state: string; count: string }>(
        `SELECT renewal_state, COUNT(*)::text AS count FROM tenants
         WHERE renewal_state != 'NONE' GROUP BY renewal_state`,
      ),
    ]);

    const branchMap = this.statusMap(branchStatus.rows);
    const tenantMap = this.statusMap(tenantStatus.rows);
    const kycMap = this.statusMap(kycCounts.rows);
    const renewalMap = this.statusMap(
      renewalCounts.rows.map((r) => ({ status: r.renewal_state, count: r.count })),
    );

    const membersTotal = Number(userCounts.rows[0]?.count ?? '0');

    return {
      branchesTotal: this.sumStatusMap(branchMap),
      branchesActive: branchMap.ACTIVE ?? 0,
      branchesSuspended: branchMap.SUSPENDED ?? 0,
      branchesArchived: branchMap.ARCHIVED ?? 0,

      tenantsFilling: tenantMap.FILLING ?? 0,
      tenantsActive: tenantMap.ACTIVE ?? 0,
      tenantsCompleted: tenantMap.COMPLETED ?? 0,
      tenantsArchived: tenantMap.ARCHIVED ?? 0,
      tenantsTotal: this.sumStatusMap(tenantMap),

      membersTotal,
      kycPending: kycMap.PENDING ?? 0,
      kycApproved: kycMap.APPROVED ?? 0,
      kycRejected: kycMap.REJECTED ?? 0,

      renewalsInVoting: renewalMap.VOTING ?? 0,
      renewalsInReplacing: renewalMap.REPLACING ?? 0,
      renewalsRenewed: renewalMap.RENEWED ?? 0,
    };
  }

  async platformMoneyThisMonth(): Promise<MoneyThisMonth> {
    const [contribRes, contribPendingRes, payoutRes, feePendingRes, payoutPendingRes] =
      await Promise.all([
        pool.query<{ sum: string; count: string }>(
          `SELECT COALESCE(SUM(amount), 0)::text AS sum, COUNT(*)::text AS count
           FROM contributions
           WHERE confirmed_at >= date_trunc('month', NOW())`,
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM contribution_intents i
           WHERE i.state IN ('PENDING', 'LATE')
             AND EXISTS (SELECT 1 FROM receipts r WHERE r.intent_id = i.id)
             AND NOT EXISTS (SELECT 1 FROM contributions c WHERE c.intent_id = i.id)`,
        ),
        pool.query<{ sum: string; count: string }>(
          `SELECT COALESCE(SUM(net_amount), 0)::text AS sum, COUNT(*)::text AS count
           FROM payout_intents
           WHERE payout_confirmed_at >= date_trunc('month', NOW())`,
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM platform_fee_intents
           WHERE state = 'RECEIPT_UPLOADED'`,
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM payout_intents
           WHERE state = 'RECEIPT_UPLOADED'`,
        ),
      ]);

    return {
      contributionsThisMonthPence: BigInt(contribRes.rows[0]?.sum ?? '0'),
      contributionsThisMonthCount: Number(contribRes.rows[0]?.count ?? '0'),
      contributionsPendingConfirmation: Number(contribPendingRes.rows[0]?.count ?? '0'),

      payoutsThisMonthPence: BigInt(payoutRes.rows[0]?.sum ?? '0'),
      payoutsThisMonthCount: Number(payoutRes.rows[0]?.count ?? '0'),
      payoutsPendingFees: Number(feePendingRes.rows[0]?.count ?? '0'),
      payoutsPendingConfirmation: Number(payoutPendingRes.rows[0]?.count ?? '0'),
    };
  }

  async platformMonthlyVolume(months = 12): Promise<MonthlyVolumeRow[]> {
    const result = await pool.query<{
      month: string;
      contributions_pence: string;
      contributions_count: string;
      payouts_pence: string;
      payouts_count: string;
    }>(
      `WITH months AS (
         SELECT generate_series(
           date_trunc('month', NOW() - ($1::int - 1) * INTERVAL '1 month'),
           date_trunc('month', NOW()),
           INTERVAL '1 month'
         ) AS month
       ),
       c AS (
         SELECT date_trunc('month', confirmed_at) AS month,
                SUM(amount) AS pence,
                COUNT(*) AS count
         FROM contributions
         WHERE confirmed_at >= date_trunc('month', NOW() - ($1::int - 1) * INTERVAL '1 month')
         GROUP BY 1
       ),
       p AS (
         SELECT date_trunc('month', payout_confirmed_at) AS month,
                SUM(net_amount) AS pence,
                COUNT(*) AS count
         FROM payout_intents
         WHERE payout_confirmed_at IS NOT NULL
           AND payout_confirmed_at >= date_trunc('month', NOW() - ($1::int - 1) * INTERVAL '1 month')
         GROUP BY 1
       )
       SELECT
         to_char(m.month, 'YYYY-MM') AS month,
         COALESCE(c.pence, 0)::text AS contributions_pence,
         COALESCE(c.count, 0)::text AS contributions_count,
         COALESCE(p.pence, 0)::text AS payouts_pence,
         COALESCE(p.count, 0)::text AS payouts_count
       FROM months m
       LEFT JOIN c ON c.month = m.month
       LEFT JOIN p ON p.month = m.month
       ORDER BY m.month ASC`,
      [months],
    );

    return result.rows.map((r) => ({
      month: r.month,
      contributionsPence: BigInt(r.contributions_pence),
      contributionsCount: Number(r.contributions_count),
      payoutsPence: BigInt(r.payouts_pence),
      payoutsCount: Number(r.payouts_count),
    }));
  }

  // ─────────────────────────────────────────────────────────────
  // Branch-scoped
  // ─────────────────────────────────────────────────────────────

  async branchCounts(branchId: string): Promise<BranchCounts> {
    const [tenantStatus, userCounts, kycCounts, renewalCounts] = await Promise.all([
      pool.query<{ status: string; count: string }>(
        `SELECT status, COUNT(*)::text AS count FROM tenants
         WHERE branch_id = $1 GROUP BY status`,
        [branchId],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM users
         WHERE role = 'SAVER' AND branch_id = $1`,
        [branchId],
      ),
      pool.query<{ status: string; count: string }>(
        `SELECT status, COUNT(*)::text AS count FROM kyc_submissions
         WHERE branch_id = $1 GROUP BY status`,
        [branchId],
      ),
      pool.query<{ renewal_state: string; count: string }>(
        `SELECT renewal_state, COUNT(*)::text AS count FROM tenants
         WHERE branch_id = $1 AND renewal_state != 'NONE'
         GROUP BY renewal_state`,
        [branchId],
      ),
    ]);

    const tenantMap = this.statusMap(tenantStatus.rows);
    const kycMap = this.statusMap(kycCounts.rows);
    const renewalMap = this.statusMap(
      renewalCounts.rows.map((r) => ({ status: r.renewal_state, count: r.count })),
    );

    return {
      tenantsFilling: tenantMap.FILLING ?? 0,
      tenantsActive: tenantMap.ACTIVE ?? 0,
      tenantsCompleted: tenantMap.COMPLETED ?? 0,
      tenantsArchived: tenantMap.ARCHIVED ?? 0,
      tenantsTotal: this.sumStatusMap(tenantMap),

      membersTotal: Number(userCounts.rows[0]?.count ?? '0'),
      kycPending: kycMap.PENDING ?? 0,
      kycApproved: kycMap.APPROVED ?? 0,
      kycRejected: kycMap.REJECTED ?? 0,

      renewalsInVoting: renewalMap.VOTING ?? 0,
      renewalsInReplacing: renewalMap.REPLACING ?? 0,
      renewalsRenewed: renewalMap.RENEWED ?? 0,
    };
  }

  async branchMoneyThisMonth(branchId: string): Promise<BranchMoneyThisMonth> {
    const [contribRes, contribPendingRes, payoutRes, feePendingRes, payoutPendingRes] =
      await Promise.all([
        pool.query<{ sum: string; count: string }>(
          `SELECT COALESCE(SUM(amount), 0)::text AS sum, COUNT(*)::text AS count
           FROM contributions
           WHERE branch_id = $1
             AND confirmed_at >= date_trunc('month', NOW())`,
          [branchId],
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM contribution_intents i
           WHERE i.branch_id = $1
             AND i.state IN ('PENDING', 'LATE')
             AND EXISTS (SELECT 1 FROM receipts r WHERE r.intent_id = i.id)
             AND NOT EXISTS (SELECT 1 FROM contributions c WHERE c.intent_id = i.id)`,
          [branchId],
        ),
        pool.query<{ sum: string; count: string }>(
          `SELECT COALESCE(SUM(net_amount), 0)::text AS sum, COUNT(*)::text AS count
           FROM payout_intents
           WHERE branch_id = $1
             AND payout_confirmed_at >= date_trunc('month', NOW())`,
          [branchId],
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM platform_fee_intents
           WHERE branch_id = $1 AND state = 'RECEIPT_UPLOADED'`,
          [branchId],
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM payout_intents
           WHERE branch_id = $1 AND state = 'RECEIPT_UPLOADED'`,
          [branchId],
        ),
      ]);

    return {
      contributionsThisMonthPence: BigInt(contribRes.rows[0]?.sum ?? '0'),
      contributionsThisMonthCount: Number(contribRes.rows[0]?.count ?? '0'),
      contributionsPendingConfirmation: Number(contribPendingRes.rows[0]?.count ?? '0'),

      payoutsThisMonthPence: BigInt(payoutRes.rows[0]?.sum ?? '0'),
      payoutsThisMonthCount: Number(payoutRes.rows[0]?.count ?? '0'),
      payoutsPendingFees: Number(feePendingRes.rows[0]?.count ?? '0'),
      payoutsPendingConfirmation: Number(payoutPendingRes.rows[0]?.count ?? '0'),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────

  private statusMap(rows: Array<{ status: string; count: string }>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = Number(r.count);
    return out;
  }

  private sumStatusMap(map: Record<string, number>): number {
    return Object.values(map).reduce((a, b) => a + b, 0);
  }
}

export const statsRepository = new StatsRepository();