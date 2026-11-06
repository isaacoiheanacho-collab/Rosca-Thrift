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
  branchesPending: number;      // <-- Onboarding pending
  branchesPendingKyc: number;   // <-- Branch admin KYC pending

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

export interface PlatformAnalytics {
  totalContributionsPence: bigint;
  totalContributionsCount: number;
  totalPayoutsPence: bigint;
  totalPayoutsCount: number;
  topBranches: Array<{ name: string; totalPence: bigint; count: number }>;
  recentActivity: Array<{ type: string; amountPence: bigint; name: string; reference: string; date: Date }>;
}

export interface PlatformFeeRevenueRow {
  month: string;            // 'YYYY-MM'
  feesPence: bigint;
  feesCount: number;
}

export interface BranchFeeSummaryRow {
  branchId: string;
  branchName: string;
  feesPaidPence: bigint;
  feesPaidCount: number;
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

    // Direct count for pending branches (Onboarding)
    const pendingBranchResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM branches WHERE onboarding_status = 'PENDING'`
    );
    const branchesPending = Number(pendingBranchResult.rows[0]?.count ?? '0');

    // Direct count for pending KYC (Branch Admins)
    const pendingKycResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count 
       FROM kyc_submissions k
       JOIN users u ON u.id = k.user_id
       WHERE k.status = 'PENDING' AND u.role = 'BRANCH_ADMIN'`
    );
    const branchesPendingKyc = Number(pendingKycResult.rows[0]?.count ?? '0');

    return {
      branchesTotal: this.sumStatusMap(branchMap),
      branchesActive: branchMap.ACTIVE ?? 0,
      branchesSuspended: branchMap.SUSPENDED ?? 0,
      branchesArchived: branchMap.ARCHIVED ?? 0,
      branchesPending,
      branchesPendingKyc,

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
           WHERE state IN ('PENDING', 'FEE_PAID', 'RECEIPT_UPLOADED')`,
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

  /**
   * NEW: Simplified financials for the Overview stats cards.
   * Renamed from `platformMoneyThisMonth` to avoid a duplicate method name.
   */
  async platformFinancialsThisMonth(): Promise<{ contribGbp: string; payoutGbp: string }> {
    const result = await pool.query<{ contrib_sum: string; payout_sum: string }>(`
      SELECT 
        (SELECT COALESCE(SUM(amount), 0)::text 
         FROM contributions 
         WHERE confirmed_at >= date_trunc('month', NOW())) AS contrib_sum,
        (SELECT COALESCE(SUM(net_amount), 0)::text 
         FROM payout_intents 
         WHERE payout_confirmed_at IS NOT NULL 
           AND payout_confirmed_at >= date_trunc('month', NOW())) AS payout_sum
    `);
    
    const row = result.rows[0]!;
    return {
      contribGbp: (Number(row.contrib_sum) / 100).toFixed(2),
      payoutGbp: (Number(row.payout_sum) / 100).toFixed(2),
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

  async platformAnalytics(): Promise<PlatformAnalytics> {
    const [
      totalsRes,
      topBranchesRes,
      recentContribsRes,
      recentPayoutsRes
    ] = await Promise.all([
      // 1. All-time totals
      pool.query<{ contrib_sum: string; contrib_count: string; payout_sum: string; payout_count: string }>(`
        SELECT 
          (SELECT COALESCE(SUM(amount), 0)::text FROM contributions) AS contrib_sum,
          (SELECT COUNT(*)::text FROM contributions) AS contrib_count,
          (SELECT COALESCE(SUM(net_amount), 0)::text FROM payout_intents WHERE payout_confirmed_at IS NOT NULL) AS payout_sum,
          (SELECT COUNT(*)::text FROM payout_intents WHERE payout_confirmed_at IS NOT NULL) AS payout_count
      `),
      
      // 2. Top branches by volume
      pool.query<{ name: string; total: string; count: string }>(`
        SELECT b.name, COALESCE(SUM(c.amount), 0)::text AS total, COUNT(c.id)::text AS count
        FROM branches b
        JOIN contributions c ON c.branch_id = b.id
        GROUP BY b.id, b.name
        ORDER BY SUM(c.amount) DESC
        LIMIT 5
      `),

      // 3. Recent contributions (for activity feed)
      pool.query<{ type: string; amount: string; name: string; reference: string; date: Date }>(`
        SELECT 'Contribution' AS type, c.amount::text, u.full_name AS name, c.reference, c.confirmed_at AS date
        FROM contributions c
        JOIN users u ON u.id = c.user_id
        ORDER BY c.confirmed_at DESC
        LIMIT 5
      `),

      // 4. Recent payouts (for activity feed)
      pool.query<{ type: string; amount: string; name: string; reference: string; date: Date }>(`
        SELECT 'Payout' AS type, p.net_amount::text AS amount, u.full_name AS name, p.reference, p.payout_confirmed_at AS date
        FROM payout_intents p
        JOIN users u ON u.id = p.recipient_user_id
        WHERE p.payout_confirmed_at IS NOT NULL
        ORDER BY p.payout_confirmed_at DESC
        LIMIT 5
      `)
    ]);

    const totals = totalsRes.rows[0]!;
    
    // Merge and sort recent activity
    const recentActivity = [...recentContribsRes.rows, ...recentPayoutsRes.rows]
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, 10);

    return {
      totalContributionsPence: BigInt(totals.contrib_sum),
      totalContributionsCount: Number(totals.contrib_count),
      totalPayoutsPence: BigInt(totals.payout_sum),
      totalPayoutsCount: Number(totals.payout_count),
      topBranches: topBranchesRes.rows.map(r => ({
        name: r.name,
        totalPence: BigInt(r.total),
        count: Number(r.count),
      })),
      recentActivity: recentActivity.map(a => ({
        type: a.type,
        amountPence: BigInt(a.amount),
        name: a.name,
        reference: a.reference,
        date: a.date,
      })),
    };
  }

  /** Platform fee revenue by month (last N months, confirmed fees only). */
  async platformFeeRevenueByMonth(months = 12): Promise<PlatformFeeRevenueRow[]> {
    const result = await pool.query<{
      month: string;
      fees_pence: string;
      fees_count: string;
    }>(
      `WITH months AS (
         SELECT generate_series(
           date_trunc('month', NOW() - ($1::int - 1) * INTERVAL '1 month'),
           date_trunc('month', NOW()),
           INTERVAL '1 month'
         ) AS month
       ),
       f AS (
         SELECT date_trunc('month', confirmed_at) AS month,
                SUM(amount) AS pence,
                COUNT(*) AS count
         FROM platform_fee_intents
         WHERE state = 'CONFIRMED'
           AND confirmed_at >= date_trunc('month', NOW() - ($1::int - 1) * INTERVAL '1 month')
         GROUP BY 1
       )
       SELECT
         to_char(m.month, 'YYYY-MM') AS month,
         COALESCE(f.pence, 0)::text AS fees_pence,
         COALESCE(f.count, 0)::text AS fees_count
       FROM months m
       LEFT JOIN f ON f.month = m.month
       ORDER BY m.month ASC`,
      [months],
    );

    return result.rows.map((r) => ({
      month: r.month,
      feesPence: BigInt(r.fees_pence),
      feesCount: Number(r.fees_count),
    }));
  }

  /** Per-branch totals of confirmed platform fees (one row per branch). */
  async platformFeesByBranch(): Promise<BranchFeeSummaryRow[]> {
    const result = await pool.query<{
      branch_id: string;
      branch_name: string;
      fees_pence: string;
      fees_count: string;
    }>(
      `SELECT
         b.id    AS branch_id,
         b.name  AS branch_name,
         COALESCE(SUM(f.amount), 0)::text AS fees_pence,
         COALESCE(COUNT(f.id), 0)::text   AS fees_count
       FROM branches b
       LEFT JOIN platform_fee_intents f
         ON f.branch_id = b.id
         AND f.state = 'CONFIRMED'
       GROUP BY b.id, b.name
       ORDER BY COALESCE(SUM(f.amount), 0) DESC`,
    );

    return result.rows.map((r) => ({
      branchId: r.branch_id,
      branchName: r.branch_name,
      feesPaidPence: BigInt(r.fees_pence),
      feesPaidCount: Number(r.fees_count),
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
        `SELECT k.status, COUNT(*)::text AS count 
         FROM kyc_submissions k
         JOIN users u ON u.id = k.user_id
         WHERE k.branch_id = $1 AND u.role = 'SAVER'
         GROUP BY k.status`,
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
           WHERE branch_id = $1 AND state IN ('PENDING', 'FEE_PAID', 'RECEIPT_UPLOADED')`,
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

  async branchContributionsByTenant(branchId: string): Promise<Array<{ tenantId: string; tenantName: string; totalPence: bigint; count: number }>> {
    const result = await pool.query<{ tenant_id: string; tenant_name: string; total: string; count: string }>(
      `SELECT 
         c.tenant_id,
         COALESCE(t.name, 'Unnamed Tenant') AS tenant_name,
         COALESCE(SUM(c.amount), 0)::text AS total,
         COUNT(c.id)::text AS count
       FROM contributions c
       JOIN tenants t ON t.id = c.tenant_id
       WHERE c.branch_id = $1
       GROUP BY c.tenant_id, t.name
       ORDER BY total DESC`,
      [branchId]
    );
    return result.rows.map(r => ({
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      totalPence: BigInt(r.total),
      count: Number(r.count),
    }));
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