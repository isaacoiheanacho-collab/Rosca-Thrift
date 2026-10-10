/**
 * Contributions service — business logic for intent creation, admin
 * confirmation, rejection, receipt uploads, and tenant/admin visibility.
 */

import { logger } from '../../logger';
import { env } from '../../config/env';
import { withTransaction, pool } from '../../db';
import { AppError, ConflictError, NotFoundError } from '../../errors';
import { uploadObject, getPresignedDownloadUrl } from '../../utils/s3';
import { buildContributionReference, parseReference } from '../../utils/reference';
import { tenantsRepository } from '../tenants/tenants.repository';
import { cycleAdvancementService } from '../tenants/cycle-advancement.service';
import { record } from '../audit/audit.service';
import { ledgerService } from '../ledger/ledger.service';
import {
  contributionsRepository,
  type ContributionIntentRow,
  type ContributionRow,
  type ReceiptRow,
} from './contributions.repository';

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

export interface ContributionIntentDto {
  id: string;
  tenantId: string;
  userId: string;
  reference: string;
  tenure: number;
  cycle: number;
  slotNumber: number;
  expectedAmountPence: string;
  deadlineAt: string;
  state: 'PENDING' | 'CONFIRMED' | 'LATE' | 'EXEMPT';
  isOverdue: boolean;
  targetAccount: {
    accountHolderName: string;
    bankName: string;
    accountNumber: string;
    sortCode: string;
  } | null;
  createdAt: string;
}

export interface ContributionDto {
  id: string;
  tenantId: string;
  userId: string;
  reference: string;
  tenure: number;
  cycle: number;
  slotNumber: number;
  amountPence: string;
  currency: string;
  confirmedAt: string;
  adminNote: string | null;
}

export interface ReceiptDto {
  id: string;
  purpose: 'CONTRIBUTION' | 'PAYOUT' | 'PLATFORM_FEE';
  intentId: string | null;
  contributionId: string | null;
  objectUrl: string;
  fileName: string;
  mimeType: string;
  uploadedBy: string;
  claimedAmountPence: string | null;
  claimedReference: string | null;
  claimedSenderName: string | null;
  claimedNote: string | null;
  createdAt: string;
}

export interface PendingIntentDto extends ContributionIntentDto {
  receipt: {
    id: string;
    objectUrl: string;
    fileName: string;
    mimeType: string;
    claimedAmountPence: string | null;
    claimedReference: string | null;
    claimedSenderName: string | null;
    claimedNote: string | null;
    uploadedAt: string;
  } | null;
}

export interface TenantCycleMemberDto {
  membershipId: string;
  userId: string;
  slotNumber: number;
  fullName: string;
  phone: string;
  intentId: string | null;
  intentState: 'PENDING' | 'CONFIRMED' | 'LATE' | 'EXEMPT' | null;
  intentReference: string | null;
  intentDeadlineAt: string | null;
  contributionId: string | null;
  contributionAmountPence: string | null;
  contributionConfirmedAt: string | null;
  hasReceipt: boolean;
}

export interface TenantLedgerDto {
  id: string;
  entryType: 'CREDIT' | 'DEBIT';
  entryKind: string;
  amountPence: string;
  amountGbp: string;
  currency: string;
  reference: string;
  description: string | null;
  createdAt: string;
}

export interface TenantReceiptDto {
  receiptId: string;
  objectUrl: string;
  fileName: string;
  mimeType: string;
  uploadedBy: string;
  uploadedByName: string;
  claimedAmountPence: string | null;
  claimedReference: string | null;
  claimedSenderName: string | null;
  intentReference: string | null;
  contributionConfirmedAt: string | null;
  createdAt: string;
}

function intentToDto(
  row: ContributionIntentRow,
  targetAccount: ContributionIntentDto['targetAccount'],
): ContributionIntentDto {
  const now = Date.now();
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    reference: row.reference,
    tenure: row.tenure,
    cycle: row.cycle,
    slotNumber: row.slot_number,
    expectedAmountPence: row.expected_amount.toString(),
    deadlineAt: row.deadline_at.toISOString(),
    state: row.state,
    isOverdue: row.deadline_at.getTime() < now && row.state === 'PENDING',
    targetAccount,
    createdAt: row.created_at.toISOString(),
  };
}

function contributionToDto(row: ContributionRow): ContributionDto {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    reference: row.reference,
    tenure: row.tenure,
    cycle: row.cycle,
    slotNumber: row.slot_number,
    amountPence: row.amount.toString(),
    currency: row.currency,
    confirmedAt: row.confirmed_at.toISOString(),
    adminNote: row.admin_note,
  };
}

async function receiptToDto(row: ReceiptRow): Promise<ReceiptDto> {
  const url = await getPresignedDownloadUrl(row.object_key, 300);
  return {
    id: row.id,
    purpose: row.purpose,
    intentId: row.intent_id,
    contributionId: row.contribution_id,
    objectUrl: url,
    fileName: row.file_name,
    mimeType: row.mime_type,
    uploadedBy: row.uploaded_by,
    claimedAmountPence: row.claimed_amount?.toString() ?? null,
    claimedReference: row.claimed_reference,
    claimedSenderName: row.claimed_sender_name,
    claimedNote: row.claimed_note,
    createdAt: row.created_at.toISOString(),
  };
}

export class ContributionsService {
  async getOrCreateCurrentIntent(
    userId: string,
    meta: RequestMeta,
  ): Promise<ContributionIntentDto> {
    // Lazy cycle-advancement trigger: if this user's tenant has a completed
    // cycle waiting to advance, advance it before doing anything else.
    try {
      await cycleAdvancementService.advanceForUser(userId);
    } catch (err) {
      logger.error({ err, userId }, 'Lazy cycle advancement failed (contributions)');
    }

    const membership = await tenantsRepository.findMembershipByUser(userId);
    if (!membership) {
      throw new AppError({
        code: 'CONTRIB_NOT_IN_TENANT',
        httpStatus: 403,
        message: 'You are not a member of any tenant',
      });
    }

    const tenant = await tenantsRepository.findById(membership.tenant_id);
    if (!tenant) throw new NotFoundError('Tenant');

    if (tenant.status !== 'ACTIVE') {
      throw new AppError({
        code: 'CONTRIB_TENANT_NOT_ACTIVE',
        httpStatus: 409,
        message: `Tenant is ${tenant.status.toLowerCase()}, contributions not yet open`,
      });
    }

    if (!tenant.cycle_contribution_deadline_at) {
      throw new AppError({
        code: 'CONTRIB_NO_CYCLE',
        httpStatus: 500,
        message: 'Tenant is active but has no cycle deadline set',
      });
    }

    const tenure = tenant.current_tenure;
    const cycle = tenant.current_cycle;

    if (cycle < 1 || cycle > 12) {
      throw new AppError({
        code: 'CONTRIB_INVALID_CYCLE',
        httpStatus: 500,
        message: `Tenant has invalid cycle: ${cycle}`,
      });
    }

    let intent = await contributionsRepository.findIntentByUserCycle(
      tenant.id,
      userId,
      tenure,
      cycle,
    );

    if (!intent) {
      const reference = buildContributionReference(
        tenant.id,
        membership.slot_number,
        tenure,
        cycle,
      );

      intent = await contributionsRepository.insertIntent({
        tenantId: tenant.id,
        userId,
        membershipId: membership.id,
        branchId: tenant.branch_id,
        tenure,
        cycle,
        slotNumber: membership.slot_number,
        reference,
        expectedAmount: BigInt(env.CONTRIBUTION_PENCE),
        deadlineAt: tenant.cycle_contribution_deadline_at,
      });

      await record({
        actorId: userId,
        action: 'CONTRIBUTION_INTENT_CREATED',
        entityType: 'contribution_intent',
        entityId: intent.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        metadata: { reference, tenantId: tenant.id, cycle, tenure },
      });

      logger.info(
        { userId, intentId: intent.id, reference, tenantId: tenant.id, cycle },
        'Contribution intent created',
      );
    }

    const poolAccount = await this.getBranchPoolAccount(tenant.branch_id);
    return intentToDto(intent, poolAccount);
  }

  private async getBranchPoolAccount(
    branchId: string,
  ): Promise<ContributionIntentDto['targetAccount']> {
    const result = await pool.query<{
      account_holder_name: string;
      bank_name: string;
      account_number: string;
      sort_code: string;
    }>('SELECT * FROM branch_pool_accounts WHERE branch_id = $1', [branchId]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      accountHolderName: row.account_holder_name,
      bankName: row.bank_name,
      accountNumber: row.account_number,
      sortCode: row.sort_code,
    };
  }

  async listMyIntents(userId: string): Promise<ContributionIntentDto[]> {
    const rows = await contributionsRepository.listIntentsByUser(userId);
    return Promise.all(rows.map((r) => intentToDto(r, null)));
  }

  async listMyContributions(userId: string): Promise<ContributionDto[]> {
    const rows = await contributionsRepository.listContributionsByUser(userId);
    return rows.map(contributionToDto);
  }

  async listTenantCycleStatus(
    tenantId: string,
    tenure: number,
    cycle: number,
  ): Promise<{ intents: ContributionIntentDto[]; contributions: ContributionDto[] }> {
    const [intents, contributions] = await Promise.all([
      contributionsRepository.listIntentsByTenantCycle(tenantId, tenure, cycle),
      contributionsRepository.listContributionsByTenantCycle(tenantId, tenure, cycle),
    ]);
    return {
      intents: intents.map((i) => intentToDto(i, null)),
      contributions: contributions.map(contributionToDto),
    };
  }

  async listPendingForAdmin(
    branchId: string | null,
    options: { limit: number; offset: number },
  ): Promise<{ intents: PendingIntentDto[]; total: number }> {
    const { intents, total } = await contributionsRepository.listPendingForBranch(
      branchId,
      options,
    );

    const dtos: PendingIntentDto[] = [];
    for (const i of intents) {
      const dto = intentToDto(i, null);
      const receipt = await contributionsRepository.findReceiptByIntentId(i.id);

      if (receipt) {
        const url = await getPresignedDownloadUrl(receipt.object_key, 300);
        dtos.push({
          ...dto,
          receipt: {
            id: receipt.id,
            objectUrl: url,
            fileName: receipt.file_name,
            mimeType: receipt.mime_type,
            claimedAmountPence: receipt.claimed_amount?.toString() ?? null,
            claimedReference: receipt.claimed_reference,
            claimedSenderName: receipt.claimed_sender_name,
            claimedNote: receipt.claimed_note,
            uploadedAt: receipt.created_at.toISOString(),
          },
        });
      } else {
        dtos.push({ ...dto, receipt: null });
      }
    }

    return { intents: dtos, total };
  }

  async listTenantCycleMembers(
    tenantId: string,
    tenure: number,
    cycle: number,
  ): Promise<TenantCycleMemberDto[]> {
    const rows = await contributionsRepository.listTenantCycleMembers(tenantId, tenure, cycle);
    return rows.map((r) => ({
      membershipId: r.membership_id,
      userId: r.user_id,
      slotNumber: r.slot_number,
      fullName: r.full_name,
      phone: r.phone,
      intentId: r.intent_id,
      intentState: r.intent_state,
      intentReference: r.intent_reference,
      intentDeadlineAt: r.intent_deadline_at?.toISOString() ?? null,
      contributionId: r.contribution_id,
      contributionAmountPence: r.contribution_amount?.toString() ?? null,
      contributionConfirmedAt: r.contribution_confirmed_at?.toISOString() ?? null,
      hasReceipt: r.has_receipt,
    }));
  }

  async listTenantLedger(tenantId: string, limit = 100): Promise<TenantLedgerDto[]> {
    const rows = await contributionsRepository.listLedgerByTenant(tenantId, limit);
    return rows.map((r) => ({
      id: r.id,
      entryType: r.entry_type,
      entryKind: r.entry_kind,
      amountPence: r.amount.toString(),
      amountGbp: (Number(r.amount) / 100).toFixed(2),
      currency: r.currency,
      reference: r.reference,
      description: r.description,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async listTenantReceipts(tenantId: string, limit = 100): Promise<TenantReceiptDto[]> {
    const rows = await contributionsRepository.listReceiptsByTenantWithIntent(tenantId, limit);
    const dtos: TenantReceiptDto[] = [];
    for (const r of rows) {
      const url = await getPresignedDownloadUrl(r.object_key, 300);
      dtos.push({
        receiptId: r.receipt_id,
        objectUrl: url,
        fileName: r.file_name,
        mimeType: r.mime_type,
        uploadedBy: r.uploaded_by,
        uploadedByName: r.uploaded_by_name,
        claimedAmountPence: r.claimed_amount?.toString() ?? null,
        claimedReference: r.claimed_reference,
        claimedSenderName: r.claimed_sender_name,
        intentReference: r.intent_reference,
        contributionConfirmedAt: r.contribution_confirmed_at?.toISOString() ?? null,
        createdAt: r.created_at.toISOString(),
      });
    }
    return dtos;
  }

  async confirmContribution(
    intentId: string,
    amount: bigint,
    adminNote: string | null,
    adminId: string,
    meta: RequestMeta,
  ): Promise<ContributionDto> {
    const intent = await contributionsRepository.findIntentById(intentId);
    if (!intent) throw new NotFoundError('Contribution intent');

    if (intent.state === 'CONFIRMED') {
      throw new ConflictError('This intent is already confirmed', 'CONTRIB_ALREADY_CONFIRMED');
    }
    if (intent.state === 'EXEMPT') {
      throw new ConflictError('This intent is marked exempt', 'CONTRIB_EXEMPT');
    }

    const created = await withTransaction(async (tx) => {
      const contribution = await contributionsRepository.insertContribution(
        {
          tenantId: intent.tenant_id,
          userId: intent.user_id,
          membershipId: intent.membership_id,
          intentId: intent.id,
          branchId: intent.branch_id,
          tenure: intent.tenure,
          cycle: intent.cycle,
          slotNumber: intent.slot_number,
          reference: intent.reference,
          amount,
          confirmedBy: adminId,
          adminNote,
        },
        tx,
      );

      await contributionsRepository.updateIntentState(intent.id, 'CONFIRMED', tx);

      await ledgerService.creditContribution(
        {
          tenantId: intent.tenant_id,
          branchId: intent.branch_id,
          reference: intent.reference,
          amount,
          contributionId: contribution.id,
          description: `Contribution confirmed for cycle ${intent.cycle}`,
          createdBy: adminId,
        },
        tx,
      );

      return contribution;
    });

    await record({
      actorId: adminId,
      action: 'CONTRIBUTION_CONFIRMED',
      entityType: 'contribution',
      entityId: created.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        intentId: intent.id,
        tenantId: intent.tenant_id,
        userId: intent.user_id,
        cycle: intent.cycle,
        amount: amount.toString(),
      },
    });

    logger.info(
      { contributionId: created.id, intentId: intent.id, adminId },
      'Contribution confirmed',
    );

    return contributionToDto(created);
  }

  async rejectContribution(
    intentId: string,
    reason: string,
    adminId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const intent = await contributionsRepository.findIntentById(intentId);
    if (!intent) throw new NotFoundError('Contribution intent');

    if (intent.state === 'CONFIRMED') {
      throw new ConflictError(
        'Cannot reject a confirmed contribution',
        'CONTRIB_ALREADY_CONFIRMED',
      );
    }

    const newState = intent.deadline_at.getTime() < Date.now() ? 'LATE' : 'PENDING';
    await contributionsRepository.updateIntentState(intent.id, newState);

    await record({
      actorId: adminId,
      action: 'CONTRIBUTION_REJECTED',
      entityType: 'contribution_intent',
      entityId: intent.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { reason, tenantId: intent.tenant_id, userId: intent.user_id },
    });

    logger.info({ intentId: intent.id, adminId }, 'Contribution rejected');
  }

  async uploadReceipt(
    userId: string,
    input: {
      intentId: string;
      claimedAmount: bigint;
      claimedReference: string;
      claimedSenderName: string;
      claimedNote?: string;
    },
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number },
    meta: RequestMeta,
  ): Promise<ReceiptDto> {
    const intent = await contributionsRepository.findIntentById(input.intentId);
    if (!intent) throw new NotFoundError('Contribution intent');
    if (intent.user_id !== userId) {
      throw new AppError({
        code: 'RECEIPT_NOT_YOURS',
        httpStatus: 403,
        message: 'This intent does not belong to you',
      });
    }
    if (intent.state === 'CONFIRMED') {
      throw new ConflictError('Intent already confirmed', 'CONTRIB_ALREADY_CONFIRMED');
    }

    const parsed = parseReference(input.claimedReference);
    if (!parsed || parsed.kind !== 'IN') {
      throw new AppError({
        code: 'RECEIPT_BAD_REFERENCE',
        httpStatus: 400,
        message: 'Reference must be a valid contribution reference (e.g. INabc123040103)',
      });
    }

    const objectKey = `receipts/contributions/${intent.branch_id}/${intent.user_id}/${Date.now()}-${file.originalname}`;
    await uploadObject(objectKey, file.buffer, file.mimetype, {
      userId,
      branchId: intent.branch_id,
      purpose: 'contribution',
    });

    const receipt = await contributionsRepository.insertReceipt({
      purpose: 'CONTRIBUTION',
      intentId: intent.id,
      contributionId: null,
      payoutId: null,
      uploadedBy: userId,
      branchId: intent.branch_id,
      objectKey,
      fileName: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: BigInt(file.size),
      claimedAmount: input.claimedAmount,
      claimedReference: input.claimedReference,
      claimedSenderName: input.claimedSenderName,
      claimedNote: input.claimedNote ?? null,
    });

    await record({
      actorId: userId,
      action: 'RECEIPT_UPLOADED',
      entityType: 'receipt',
      entityId: receipt.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { intentId: intent.id, objectKey },
    });

    logger.info({ receiptId: receipt.id, intentId: intent.id }, 'Receipt uploaded');
    return receiptToDto(receipt);
  }
}

export const contributionsService = new ContributionsService();