/**
 * Ledger service — writes append-only entries. All money movements go through here.
 *
 * Every method takes an optional transaction client (tx) so callers can wrap
 * ledger writes in the same transaction as their business operation.
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
}

export const ledgerService = new LedgerService();