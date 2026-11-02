/**
 * Ledger service — writes append-only entries. All money movements go through here.
 *
 * Every method takes an optional transaction client (tx) so callers can wrap
 * ledger writes in the same transaction as their business operation.
 *
 * Account model:
 *   - TENANT      — the pooled savings balance a cycle draws payouts from.
 *   - BRANCH_FEE  — per-branch fee-tracking (what the branch has paid in).
 *   - PLATFORM    — the platform's own maintenance balance.
 *   - TVC         — Time-Value Contribution pool. Holds the early-vs-late
 *                   adjustment amounts so a full cycle nets to zero.
 *
 * The TVC flow uses `moveTvc` to atomically write TWO ledger entries
 * (one TENANT side, one TVC side) so a single call cannot leave the two
 * pools out of sync.
 */

import { logger } from '../../logger';
import { ledgerRepository, type LedgerEntryRow } from './ledger.repository';
import type { PoolClient } from 'pg';

export interface CreditContributionInput {
  tenantId: string;
  branchId: string;
  reference: string;
  amount: bigint;
  contributionId: string;
  description: string;
  createdBy: string | null;
}

export interface CreditPlatformFeeInput {
  tenantId: string;
  branchId: string;
  reference: string;
  amount: bigint;
  description: string;
  createdBy: string | null;
}

export interface DebitPayoutInput {
  tenantId: string;
  branchId: string;
  reference: string;
  amount: bigint;
  payoutId: string;
  description: string;
  createdBy: string | null;
}

export interface MoveTvcInput {
  tenantId: string;
  branchId: string;
  reference: string;
  amount: bigint; // positive; direction determined by entryType
  entryType: 'CREDIT' | 'DEBIT';
  payoutId: string;
  description: string;
  createdBy: string | null;
}

export class LedgerService {
  /** Credit a tenant pool when a contribution is confirmed. */
  async creditContribution(
    input: CreditContributionInput,
    tx?: PoolClient,
  ): Promise<LedgerEntryRow> {
    const entry = await ledgerRepository.insert(
      {
        accountType: 'TENANT',
        tenantId: input.tenantId,
        branchId: input.branchId,
        entryType: 'CREDIT',
        amount: input.amount,
        currency: 'GBP',
        reference: input.reference,
        entryKind: 'CONTRIBUTION',
        contributionId: input.contributionId,
        payoutId: null,
        description: input.description,
        createdBy: input.createdBy,
      },
      tx,
    );
    logger.info(
      { ledgerEntryId: entry.id, tenantId: input.tenantId, amount: input.amount.toString() },
      'Ledger: contribution credited',
    );
    return entry;
  }

  /** Credit the platform maintenance account when a branch pays the fee. */
  async creditPlatformFee(
    input: CreditPlatformFeeInput,
    tx?: PoolClient,
  ): Promise<LedgerEntryRow> {
    const entry = await ledgerRepository.insert(
      {
        accountType: 'PLATFORM',
        tenantId: null,
        branchId: input.branchId,
        entryType: 'CREDIT',
        amount: input.amount,
        currency: 'GBP',
        reference: input.reference,
        entryKind: 'PLATFORM_FEE',
        contributionId: null,
        payoutId: null,
        description: input.description,
        createdBy: input.createdBy,
      },
      tx,
    );
    logger.info(
      { ledgerEntryId: entry.id, branchId: input.branchId, amount: input.amount.toString() },
      'Ledger: platform fee credited',
    );
    return entry;
  }

  /** Debit a tenant pool when a payout is confirmed. */
  async debitPayout(input: DebitPayoutInput, tx?: PoolClient): Promise<LedgerEntryRow> {
    const entry = await ledgerRepository.insert(
      {
        accountType: 'TENANT',
        tenantId: input.tenantId,
        branchId: input.branchId,
        entryType: 'DEBIT',
        amount: input.amount,
        currency: 'GBP',
        reference: input.reference,
        entryKind: 'PAYOUT',
        contributionId: null,
        payoutId: input.payoutId,
        description: input.description,
        createdBy: input.createdBy,
      },
      tx,
    );
    logger.info(
      { ledgerEntryId: entry.id, tenantId: input.tenantId, amount: input.amount.toString() },
      'Ledger: payout debited',
    );
    return entry;
  }

  /**
   * Move TVC money from the TENANT pool into the TVC pool (early collector's
   * penalty), OR from the TVC pool back into the TENANT pool (late collector's
   * bonus).
   *
   * Direction:
   *   - `entryType = 'CREDIT'`  → credits the TVC pool, debits the tenant pool
   *   - `entryType = 'DEBIT'`   → debits the TVC pool, credits the tenant pool
   *
   * Always writes TWO symmetric ledger entries in one call so the pool
   * accounting stays consistent no matter what. If either insert fails,
   * the caller's transaction should roll back — leaving one side of a
   * transfer written without its mirror would corrupt the ledger.
   */
  async moveTvc(
    input: MoveTvcInput,
    tx?: PoolClient,
  ): Promise<{ tenantEntry: LedgerEntryRow; tvcEntry: LedgerEntryRow }> {
    // If we're CREDITING the TVC pool, we DEBIT the tenant pool (and vice versa).
    const tenantEntryType = input.entryType === 'CREDIT' ? 'DEBIT' : 'CREDIT';

    // 1. Tenant pool side
    const tenantEntry = await ledgerRepository.insert(
      {
        accountType: 'TENANT',
        tenantId: input.tenantId,
        branchId: input.branchId,
        entryType: tenantEntryType,
        amount: input.amount,
        currency: 'GBP',
        reference: input.reference,
        entryKind: 'TVC_ADJUSTMENT',
        contributionId: null,
        payoutId: input.payoutId,
        description: `TVC ${tenantEntryType === 'DEBIT' ? 'penalty moved to TVC pool' : 'bonus drawn from TVC pool'}: ${input.description}`,
        createdBy: input.createdBy,
      },
      tx,
    );

    // 2. TVC pool side
    const tvcEntry = await ledgerRepository.insert(
      {
        accountType: 'TVC',
        tenantId: input.tenantId,
        branchId: input.branchId,
        entryType: input.entryType,
        amount: input.amount,
        currency: 'GBP',
        reference: input.reference,
        entryKind: 'TVC_ADJUSTMENT',
        contributionId: null,
        payoutId: input.payoutId,
        description: `TVC ${input.entryType === 'CREDIT' ? 'penalty credited' : 'bonus debited'}: ${input.description}`,
        createdBy: input.createdBy,
      },
      tx,
    );

    logger.info(
      {
        tenantEntryId: tenantEntry.id,
        tvcEntryId: tvcEntry.id,
        tenantId: input.tenantId,
        amount: input.amount.toString(),
        direction: input.entryType,
      },
      'Ledger: TVC moved',
    );

    return { tenantEntry, tvcEntry };
  }

  /**
   * Debit the tenant pool for the platform fee.
   *
   * This is the counterpart to `creditPlatformFee`: the fee leaves the tenant
   * pool and lands in the platform maintenance account. Callers should write
   * both in the same transaction — either both succeed or neither does.
   */
  async debitTenantForFee(
    input: DebitPayoutInput,
    tx?: PoolClient,
  ): Promise<LedgerEntryRow> {
    const entry = await ledgerRepository.insert(
      {
        accountType: 'TENANT',
        tenantId: input.tenantId,
        branchId: input.branchId,
        entryType: 'DEBIT',
        amount: input.amount,
        currency: 'GBP',
        reference: input.reference,
        entryKind: 'PLATFORM_FEE',
        contributionId: null,
        payoutId: input.payoutId,
        description: input.description,
        createdBy: input.createdBy,
      },
      tx,
    );
    logger.info(
      { ledgerEntryId: entry.id, tenantId: input.tenantId, amount: input.amount.toString() },
      'Ledger: platform fee debited from tenant pool',
    );
    return entry;
  }
}

export const ledgerService = new LedgerService();