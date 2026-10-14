/**
 * Notifications service.
 *
 * The single entry point for creating + delivering notifications.
 *
 * Public API:
 *   - notify(...)             - one user, one event
 *   - notifyMany(...)         - N users, same event
 *   - notifyTenant(...)       - all active members of a tenant
 *   - notifySuperAdmins(...)  - all super admins
 *   - notifyBranchAdmins(...) - all branch admins for a branch
 *
 * Event helpers (each wraps notify/notifyMany with proper title + body):
 *   - notifyKycApproved
 *   - notifyContributionUploaded
 *   - notifyContributionConfirmed
 *   - notifyContributionRejected
 *   - notifyDepositReminder
 *   - notifyFeeReceiptUploaded
 *   - notifyFeeConfirmed
 *   - notifyFeeRejected
 *   - notifyPayoutReceiptUploaded
 *   - notifyPayoutFailed
 *   - notifyPayoutRetried
 *   - notifyCycleAdvanced
 *   - notifyRenewalOpened
 *   - notifyRenewalDeclined
 *   - notifyReplacementAssigned
 *   - notifyTenureRenewed
 *   - notifyTenantActivated
 *   - notifyTenantDissolved
 *
 * Every helper:
 *   1. Inserts one row per recipient into `notifications`
 *   2. Fires delivery asynchronously (Socket.IO + Web Push) - best-effort
 *
 * Never throws. Failures are logged.
 */

import { logger } from '../../logger';
import { formatPence } from '../../utils/money';
import { record } from '../audit/audit.service';
import { realtimeService } from '../realtime/realtime.service';
import {
  notificationsRepository,
  type NotificationRow,
} from './notifications.repository';

export interface NotifyInput {
  userId: string;
  kind: string;
  title: string;
  body: string;
  tenantId?: string | null;
  branchId?: string | null;
  metadata?: Record<string, unknown>;
}

export class NotificationsService {
  // ---------------------------------------------------------------
  // Core API
  // ---------------------------------------------------------------

  async notify(input: NotifyInput): Promise<NotificationRow | null> {
    try {
      const row = await notificationsRepository.insert({
        userId: input.userId,
        tenantId: input.tenantId ?? null,
        branchId: input.branchId ?? null,
        kind: input.kind,
        title: input.title,
        body: input.body,
        metadata: input.metadata ?? {},
      });

      void realtimeService
        .deliver({
          id: row.id,
          userId: row.user_id,
          kind: row.kind,
          title: row.title,
          body: row.body,
          metadata: row.metadata,
          createdAt: row.created_at,
        })
        .catch((err) => logger.error({ err, notificationId: row.id }, 'Delivery failed'));

      return row;
    } catch (err) {
      logger.error({ err, userId: input.userId, kind: input.kind }, 'Notification insert failed');
      return null;
    }
  }

  async notifyMany(inputs: NotifyInput[]): Promise<NotificationRow[]> {
    if (inputs.length === 0) return [];
    try {
      const rows = await notificationsRepository.insertMany(
        inputs.map((i) => ({
          userId: i.userId,
          tenantId: i.tenantId ?? null,
          branchId: i.branchId ?? null,
          kind: i.kind,
          title: i.title,
          body: i.body,
          metadata: i.metadata ?? {},
        })),
      );

      for (const row of rows) {
        void realtimeService
          .deliver({
            id: row.id,
            userId: row.user_id,
            kind: row.kind,
            title: row.title,
            body: row.body,
            metadata: row.metadata,
            createdAt: row.created_at,
          })
          .catch((err) => logger.error({ err, notificationId: row.id }, 'Delivery failed'));
      }

      return rows;
    } catch (err) {
      logger.error({ err, count: inputs.length }, 'Notification bulk insert failed');
      return [];
    }
  }

  async notifyTenant(params: {
    tenantId: string;
    branchId: string;
    kind: string;
    title: string;
    body: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const userIds = await notificationsRepository.listTenantMemberUserIds(params.tenantId);
    if (userIds.length === 0) return;

    await this.notifyMany(
      userIds.map((userId) => ({
        userId,
        kind: params.kind,
        title: params.title,
        body: params.body,
        tenantId: params.tenantId,
        branchId: params.branchId,
        metadata: params.metadata ?? {},
      })),
    );
  }

  async notifySuperAdmins(params: {
    kind: string;
    title: string;
    body: string;
    branchId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const userIds = await notificationsRepository.listSuperAdminUserIds();
    if (userIds.length === 0) return;

    await this.notifyMany(
      userIds.map((userId) => ({
        userId,
        kind: params.kind,
        title: params.title,
        body: params.body,
        tenantId: null,
        branchId: params.branchId ?? null,
        metadata: params.metadata ?? {},
      })),
    );
  }

  async notifyBranchAdmins(params: {
    branchId: string;
    kind: string;
    title: string;
    body: string;
    tenantId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const userIds = await notificationsRepository.listBranchAdminUserIds(params.branchId);
    if (userIds.length === 0) return;

    await this.notifyMany(
      userIds.map((userId) => ({
        userId,
        kind: params.kind,
        title: params.title,
        body: params.body,
        tenantId: params.tenantId ?? null,
        branchId: params.branchId,
        metadata: params.metadata ?? {},
      })),
    );
  }

  // ---------------------------------------------------------------
  // Event helpers
  // ---------------------------------------------------------------

  async notifyKycApproved(params: { userId: string; branchId: string }): Promise<void> {
    await this.notify({
      userId: params.userId,
      kind: 'KYC_APPROVED',
      title: 'Identity verified',
      body: 'Your identity has been verified. Welcome to the circle.',
      branchId: params.branchId,
    });
  }

  async notifyContributionUploaded(params: {
    branchId: string;
    tenantId: string;
    saverUserId: string;
    saverName: string;
    cycle: number;
    intentId: string;
  }): Promise<void> {
    await this.notifyBranchAdmins({
      branchId: params.branchId,
      tenantId: params.tenantId,
      kind: 'CONTRIBUTION_UPLOADED',
      title: 'Contribution receipt uploaded',
      body: `${params.saverName} uploaded a receipt for cycle ${params.cycle}. Please verify.`,
      metadata: { intentId: params.intentId, cycle: params.cycle },
    });
  }

  async notifyContributionConfirmed(params: {
    tenantId: string;
    branchId: string;
    saverUserId: string;
    saverName: string;
    cycle: number;
    amount: bigint;
    contributionId: string;
  }): Promise<void> {
    const amount = formatPence(params.amount);
    await this.notifyTenant({
      tenantId: params.tenantId,
      branchId: params.branchId,
      kind: 'CONTRIBUTION_CONFIRMED',
      title: 'Contribution confirmed',
      body: `${params.saverName} contributed ${amount} to cycle ${params.cycle}.`,
      metadata: { contributionId: params.contributionId, cycle: params.cycle },
    });
  }

  async notifyContributionRejected(params: {
    tenantId: string;
    branchId: string;
    saverUserId: string;
    saverName: string;
    cycle: number;
    intentId: string;
  }): Promise<void> {
    await this.notifyTenant({
      tenantId: params.tenantId,
      branchId: params.branchId,
      kind: 'CONTRIBUTION_REJECTED',
      title: 'Contribution could not be verified',
      body: `${params.saverName}'s contribution for cycle ${params.cycle} could not be verified. Please check the reference and try again, or contact your branch admin.`,
      metadata: { intentId: params.intentId, cycle: params.cycle },
    });
  }

  async notifyDepositReminder(params: {
    tenantId: string;
    branchId: string;
    cycle: number;
    deadlineAt: Date;
  }): Promise<void> {
    const deadline = params.deadlineAt.toISOString().slice(0, 10);
    await this.notifyTenant({
      tenantId: params.tenantId,
      branchId: params.branchId,
      kind: 'DEPOSIT_REMINDER',
      title: 'Contribution reminder',
      body: `Cycle ${params.cycle} contributions are due. Please pay by ${deadline}.`,
      metadata: { cycle: params.cycle, deadlineAt: params.deadlineAt.toISOString() },
    });
  }

  async notifyFeeReceiptUploaded(params: {
    tenantId: string;
    branchId: string;
    cycle: number;
    feeIntentId: string;
    branchName: string;
  }): Promise<void> {
    await this.notifySuperAdmins({
      branchId: params.branchId,
      kind: 'FEE_RECEIPT_UPLOADED',
      title: 'Fee receipt uploaded',
      body: `${params.branchName} uploaded a fee receipt for cycle ${params.cycle}. Please verify.`,
      metadata: { feeIntentId: params.feeIntentId, cycle: params.cycle, tenantId: params.tenantId },
    });
  }

  async notifyFeeConfirmed(params: {
    tenantId: string;
    branchId: string;
    cycle: number;
    payoutIntentId: string;
    reference: string;
  }): Promise<void> {
    await this.notifyBranchAdmins({
      branchId: params.branchId,
      tenantId: params.tenantId,
      kind: 'FEE_CONFIRMED',
      title: 'Payout unlocked',
      body: `Cycle ${params.cycle} fee confirmed. Payout reference ${params.reference} is ready to send.`,
      metadata: { payoutIntentId: params.payoutIntentId, cycle: params.cycle, reference: params.reference },
    });
  }

  async notifyFeeRejected(params: {
    tenantId: string;
    branchId: string;
    cycle: number;
    feeIntentId: string;
    reason: string;
  }): Promise<void> {
    await this.notifyBranchAdmins({
      branchId: params.branchId,
      tenantId: params.tenantId,
      kind: 'FEE_REJECTED',
      title: 'Fee receipt could not be verified',
      body: `Cycle ${params.cycle} fee receipt could not be verified. Please check with your bank and re-upload.`,
      metadata: { feeIntentId: params.feeIntentId, cycle: params.cycle },
    });
  }

  async notifyPayoutReceiptUploaded(params: {
    tenantId: string;
    branchId: string;
    cycle: number;
    payoutIntentId: string;
    recipientName: string;
    recipientSlot: number;
    netAmount: bigint;
  }): Promise<void> {
    const amount = formatPence(params.netAmount);
    await this.notifyTenant({
      tenantId: params.tenantId,
      branchId: params.branchId,
      kind: 'PAYOUT_CONFIRMED',
      title: 'Payout made',
      body: `Cycle ${params.cycle} payout of ${amount} was sent to Saver ${params.recipientSlot} (${params.recipientName}).`,
      metadata: {
        payoutIntentId: params.payoutIntentId,
        cycle: params.cycle,
        recipientSlot: params.recipientSlot,
        amountPence: params.netAmount.toString(),
      },
    });
  }

  async notifyPayoutFailed(params: {
    tenantId: string;
    branchId: string;
    cycle: number;
    payoutIntentId: string;
  }): Promise<void> {
    await this.notifyTenant({
      tenantId: params.tenantId,
      branchId: params.branchId,
      kind: 'PAYOUT_FAILED',
      title: 'Payout could not be completed',
      body: `Cycle ${params.cycle} payout could not be completed. A retry is in progress.`,
      metadata: { payoutIntentId: params.payoutIntentId, cycle: params.cycle },
    });
  }

  async notifyPayoutRetried(params: {
    tenantId: string;
    branchId: string;
    cycle: number;
    payoutIntentId: string;
  }): Promise<void> {
    await this.notifyTenant({
      tenantId: params.tenantId,
      branchId: params.branchId,
      kind: 'PAYOUT_RETRIED',
      title: 'Payout has been reissued',
      body: `Cycle ${params.cycle} payout has been reissued. You will be notified when it completes.`,
      metadata: { payoutIntentId: params.payoutIntentId, cycle: params.cycle },
    });
  }

  async notifyCycleAdvanced(params: {
    tenantId: string;
    branchId: string;
    newCycle: number;
  }): Promise<void> {
    await this.notifyTenant({
      tenantId: params.tenantId,
      branchId: params.branchId,
      kind: 'CYCLE_ADVANCED',
      title: `Cycle ${params.newCycle} has begun`,
      body: `Welcome to cycle ${params.newCycle}. Contributions are open.`,
      metadata: { cycle: params.newCycle },
    });
  }

  async notifyRenewalOpened(params: {
    tenantId: string;
    branchId: string;
    closingTenure: number;
  }): Promise<void> {
    await this.notifyTenant({
      tenantId: params.tenantId,
      branchId: params.branchId,
      kind: 'RENEWAL_OPENED',
      title: 'Renewal vote open',
      body: `Your circle completed tenure ${params.closingTenure}. Vote to renew for another year.`,
      metadata: { closingTenure: params.closingTenure },
    });
  }

  async notifyRenewalDeclined(params: {
    tenantId: string;
    branchId: string;
    slotNumber: number;
    memberName: string;
  }): Promise<void> {
    await this.notifyBranchAdmins({
      branchId: params.branchId,
      tenantId: params.tenantId,
      kind: 'RENEWAL_DECLINED',
      title: 'Renewal declined - replacement needed',
      body: `${params.memberName} (slot ${params.slotNumber}) declined renewal. Please find a replacement.`,
      metadata: { slotNumber: params.slotNumber },
    });
  }

  async notifyReplacementAssigned(params: {
    tenantId: string;
    branchId: string;
    replacementName: string;
    slotNumber: number;
  }): Promise<void> {
    await this.notifyTenant({
      tenantId: params.tenantId,
      branchId: params.branchId,
      kind: 'REPLACEMENT_ASSIGNED',
      title: 'Replacement joined',
      body: `${params.replacementName} has joined slot ${params.slotNumber}.`,
      metadata: { slotNumber: params.slotNumber },
    });
  }

  async notifyTenureRenewed(params: {
    tenantId: string;
    branchId: string;
    newTenure: number;
  }): Promise<void> {
    await this.notifyTenant({
      tenantId: params.tenantId,
      branchId: params.branchId,
      kind: 'TENURE_RENEWED',
      title: `Tenure ${params.newTenure} has begun`,
      body: `Your circle has renewed. Welcome back.`,
      metadata: { tenure: params.newTenure },
    });
  }

  async notifyTenantActivated(params: {
    tenantId: string;
    branchId: string;
    cycleContributionDeadlineAt: Date;
  }): Promise<void> {
    const deadline = params.cycleContributionDeadlineAt.toISOString().slice(0, 10);
    await this.notifyTenant({
      tenantId: params.tenantId,
      branchId: params.branchId,
      kind: 'TENANT_ACTIVATED',
      title: 'Your circle is full',
      body: `All 12 members are in. Cycle 1 begins now. First contribution due by ${deadline}.`,
      metadata: { deadlineAt: params.cycleContributionDeadlineAt.toISOString() },
    });
  }

  async notifyTenantDissolved(params: {
    tenantId: string;
    branchId: string;
  }): Promise<void> {
    await this.notifyTenant({
      tenantId: params.tenantId,
      branchId: params.branchId,
      kind: 'TENANT_DISSOLVED',
      title: 'Circle ended',
      body: 'Your circle has ended. Please contact your branch admin.',
    });
  }

  // ---------------------------------------------------------------
  // Feed + read APIs
  // ---------------------------------------------------------------

  async listMyNotifications(
    userId: string,
    options: { limit: number; offset: number; unreadOnly?: boolean },
  ): Promise<{ notifications: NotificationRow[]; total: number; unread: number }> {
    const [{ notifications, total }, unread] = await Promise.all([
      notificationsRepository.listByUser(userId, options),
      notificationsRepository.unreadCount(userId),
    ]);
    return { notifications, total, unread };
  }

  async getUnreadCount(userId: string): Promise<number> {
    return notificationsRepository.unreadCount(userId);
  }

  async markRead(id: string, userId: string): Promise<NotificationRow | null> {
    return notificationsRepository.markRead(id, userId);
  }

  async markAllRead(userId: string): Promise<number> {
    const count = await notificationsRepository.markAllRead(userId);
    await record({
      actorId: userId,
      action: 'NOTIFICATIONS_MARKED_READ',
      entityType: 'notification',
      metadata: { count },
    });
    return count;
  }
}

export const notificationsService = new NotificationsService();