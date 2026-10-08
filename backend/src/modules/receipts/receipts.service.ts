/**
 * Receipts service — read-only access to receipt records, presigning URLs.
 */

import { getPresignedDownloadUrl } from '../../utils/s3';
import { NotFoundError } from '../../errors';
import { receiptsRepository } from './receipts.repository';
import type { ReceiptRow } from '../contributions/contributions.repository';

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

async function toDto(row: ReceiptRow): Promise<ReceiptDto> {
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

export class ReceiptsService {
  async getById(id: string): Promise<ReceiptDto> {
    const row = await receiptsRepository.findById(id);
    if (!row) throw new NotFoundError('Receipt');
    return toDto(row);
  }

  async listByIntent(intentId: string): Promise<ReceiptDto[]> {
    const rows = await receiptsRepository.listByIntent(intentId);
    return Promise.all(rows.map(toDto));
  }

  async listByTenant(tenantId: string, limit = 100): Promise<ReceiptDto[]> {
    const rows = await receiptsRepository.listByTenant(tenantId, limit);
    return Promise.all(rows.map(toDto));
  }
}

export const receiptsService = new ReceiptsService();