/**
 * Stats service — assembles DTOs from repository results.
 *
 * All endpoints are read-only. No mutations. No audit logging (reads
 * don't need to be traced).
 */

import { NotFoundError } from '../../errors';
import { branchesRepository } from '../branches/branches.repository';
import { formatPence } from '../../utils/money';
import {
  statsRepository,
  type BranchCounts,
  type BranchMoneyThisMonth,
  type MonthlyVolumeRow,
  type MoneyThisMonth,
  type PlatformCounts,
} from './stats.repository';

export interface SuperAdminStatsDto {
  branches: {
    total: number;
    active: number;
    suspended: number;
    archived: number;
  };
  tenants: {
    filling: number;
    active: number;
    completed: number;
    archived: number;
    total: number;
  };
  members: {
    total: number;
    kycPending: number;
    kycApproved: number;
    kycRejected: number;
  };
  contributions: {
    thisMonthPence: string;
    thisMonthGbp: string;
    thisMonthCount: number;
    pendingConfirmation: number;
  };
  payouts: {
    thisMonthPence: string;
    thisMonthGbp: string;
    thisMonthCount: number;
    pendingFees: number;
    pendingConfirmation: number;
  };
  renewals: {
    inVoting: number;
    inReplacing: number;
    renewed: number;
  };
}

export interface BranchAdminStatsDto {
  branchId: string;
  branchName: string;
  tenants: SuperAdminStatsDto['tenants'];
  members: SuperAdminStatsDto['members'];
  contributions: SuperAdminStatsDto['contributions'];
  payouts: SuperAdminStatsDto['payouts'];
  renewals: SuperAdminStatsDto['renewals'];
}

export interface MonthlyVolumeDto {
  month: string;
  contributionsPence: string;
  contributionsGbp: string;
  contributionsCount: number;
  payoutsPence: string;
  payoutsGbp: string;
  payoutsCount: number;
}

type SharedStatsBlocks = Omit<SuperAdminStatsDto, 'branches'>;

/**
 * Build the shared blocks (tenants, members, contributions, payouts, renewals).
 * Works for both platform-wide and branch-scoped data.
 */
function assembleSharedBlocks(
  counts: PlatformCounts | BranchCounts,
  money: MoneyThisMonth | BranchMoneyThisMonth,
): SharedStatsBlocks {
  return {
    tenants: {
      filling: counts.tenantsFilling,
      active: counts.tenantsActive,
      completed: counts.tenantsCompleted,
      archived: counts.tenantsArchived,
      total: counts.tenantsTotal,
    },
    members: {
      total: counts.membersTotal,
      kycPending: counts.kycPending,
      kycApproved: counts.kycApproved,
      kycRejected: counts.kycRejected,
    },
    contributions: {
      thisMonthPence: money.contributionsThisMonthPence.toString(),
      thisMonthGbp: formatPence(money.contributionsThisMonthPence),
      thisMonthCount: money.contributionsThisMonthCount,
      pendingConfirmation: money.contributionsPendingConfirmation,
    },
    payouts: {
      thisMonthPence: money.payoutsThisMonthPence.toString(),
      thisMonthGbp: formatPence(money.payoutsThisMonthPence),
      thisMonthCount: money.payoutsThisMonthCount,
      pendingFees: money.payoutsPendingFees,
      pendingConfirmation: money.payoutsPendingConfirmation,
    },
    renewals: {
      inVoting: counts.renewalsInVoting,
      inReplacing: counts.renewalsInReplacing,
      renewed: counts.renewalsRenewed,
    },
  };
}

export class StatsService {
  async getSuperAdminStats(): Promise<SuperAdminStatsDto> {
    const [counts, money] = await Promise.all([
      statsRepository.platformCounts(),
      statsRepository.platformMoneyThisMonth(),
    ]);

    const shared = assembleSharedBlocks(counts, money);

    return {
      ...shared,
      branches: {
        total: counts.branchesTotal,
        active: counts.branchesActive,
        suspended: counts.branchesSuspended,
        archived: counts.branchesArchived,
      },
    };
  }

  async getMonthlyVolume(months = 12): Promise<MonthlyVolumeDto[]> {
    const rows = await statsRepository.platformMonthlyVolume(months);
    return rows.map((r: MonthlyVolumeRow) => ({
      month: r.month,
      contributionsPence: r.contributionsPence.toString(),
      contributionsGbp: formatPence(r.contributionsPence),
      contributionsCount: r.contributionsCount,
      payoutsPence: r.payoutsPence.toString(),
      payoutsGbp: formatPence(r.payoutsPence),
      payoutsCount: r.payoutsCount,
    }));
  }

  async getBranchAdminStats(branchId: string): Promise<BranchAdminStatsDto> {
    const branch = await branchesRepository.findById(branchId);
    if (!branch) throw new NotFoundError('Branch');

    const [counts, money] = await Promise.all([
      statsRepository.branchCounts(branchId),
      statsRepository.branchMoneyThisMonth(branchId),
    ]);

    const shared = assembleSharedBlocks(counts, money);

    return {
      branchId,
      branchName: branch.name,
      tenants: shared.tenants,
      members: shared.members,
      contributions: shared.contributions,
      payouts: shared.payouts,
      renewals: shared.renewals,
    };
  }
}

export const statsService = new StatsService();