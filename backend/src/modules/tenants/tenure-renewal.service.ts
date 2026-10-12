/**
 * Tenure renewal service.
 *
 * Lifecycle:
 *   NONE       -> normal operating tenant (in-tenure)
 *   VOTING     -> cycle 12 done, 7-day vote window open
 *   REPLACING  -> at least one NO vote; 7-day fill window open
 *   READY      -> 12 slots confirmed for next tenure; ready to activate
 *   RENEWED    -> tenure 2+ active
 *   DISSOLVED  -> could not reach 12; admin closed it
 *
 * Called from:
 *   - cycleAdvancementService (opens renewal on cycle 12)
 *   - provisioner (checks for REPLACING tenant before FILLING)
 *   - lazy trigger on dashboard load (checks window expiry)
 */

import { logger } from '../../logger';
import { pool, withTransaction } from '../../db';
import { AppError, ConflictError, NotFoundError } from '../../errors';
import { record } from '../audit/audit.service';
import {
  tenantsRepository,
  type TenantRow,
  type TenantMembershipRow,
} from './tenants.repository';
import { tenureRenewalRepository } from './tenure-renewal.repository';
import { rotationService } from '../payouts/rotation.service';
import { usersRepository } from '../users/users.repository';

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

export interface RenewalStatusDto {
  tenantId: string;
  renewalState: 'NONE' | 'VOTING' | 'REPLACING' | 'READY' | 'RENEWED' | 'DISSOLVED';
  closingTenure: number;
  nextTenure: number;
  voteEndsAt: string | null;
  fillEndsAt: string | null;
  yesCount: number;
  noCount: number;
  pendingCount: number;
  replacedCount: number;
  unfilledSlots: number[];
}

export interface RenewalMemberDto {
  renewalId: string;
  userId: string;
  fullName: string;
  slotNumber: number;
  vote: 'PENDING' | 'YES' | 'NO';
  votedAt: string | null;
  replacementUserId: string | null;
  replacementName: string | null;
  replacedAt: string | null;
}

const VOTE_WINDOW_DAYS = 7;
const FILL_WINDOW_DAYS = 7;

export class TenureRenewalService {
  // ---------------------------------------------------------------
  // Step 1: open renewal after cycle 12 payout confirmed
  // ---------------------------------------------------------------

  /**
   * Called by cycleAdvancementService when cycle 12 completes.
   * Creates 12 renewal rows, sets tenant state = VOTING.
   * Idempotent.
   */
  async openRenewalForTenant(tenantId: string): Promise<void> {
    const tenant = await tenantsRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');

    if (tenant.renewal_state !== 'NONE') {
      logger.debug({ tenantId, state: tenant.renewal_state }, 'Renewal already open');
      return;
    }

    const memberships = await tenantsRepository.findMembershipsByTenant(tenantId);
    if (memberships.length !== 12) {
      logger.warn(
        { tenantId, count: memberships.length },
        'Cannot open renewal: tenant does not have 12 memberships',
      );
      return;
    }

    const closingTenure = tenant.current_tenure;
    const nextTenure = closingTenure + 1;
    const now = new Date();
    const voteEndsAt = new Date(now.getTime() + VOTE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    await withTransaction(async (tx) => {
      await tenureRenewalRepository.insertMany(
        memberships.map((m) => ({
          tenantId,
          closingTenure,
          nextTenure,
          userId: m.user_id,
          membershipId: m.id,
          slotNumber: m.slot_number,
        })),
        tx,
      );

      await tx.query(
        `UPDATE tenants
         SET renewal_state = 'VOTING',
             renewal_opened_at = NOW(),
             renewal_vote_ends_at = $2,
             tenure_started_at = COALESCE(tenure_started_at, activated_at, NOW())
         WHERE id = $1`,
        [tenantId, voteEndsAt],
      );

      await record(
        {
          actorId: null,
          action: 'TENURE_RENEWAL_OPENED',
          entityType: 'tenant',
          entityId: tenantId,
          metadata: { closingTenure, nextTenure, voteEndsAt: voteEndsAt.toISOString() },
        },
        tx,
      );
    });

    logger.info({ tenantId, closingTenure, voteEndsAt }, 'Tenure renewal opened');
  }

  // ---------------------------------------------------------------
  // Step 2: cast vote
  // ---------------------------------------------------------------

  async castVote(
    userId: string,
    vote: 'YES' | 'NO',
    meta: RequestMeta,
  ): Promise<RenewalStatusDto> {
    const membership = await tenantsRepository.findMembershipByUser(userId);
    if (!membership) {
      throw new AppError({
        code: 'RENEWAL_NOT_IN_TENANT',
        httpStatus: 403,
        message: 'You are not in a tenant',
      });
    }

    const tenant = await tenantsRepository.findById(membership.tenant_id);
    if (!tenant) throw new NotFoundError('Tenant');

    if (tenant.renewal_state !== 'VOTING' && tenant.renewal_state !== 'REPLACING') {
      throw new ConflictError(
        `Tenant is not in a renewal vote (state=${tenant.renewal_state})`,
        'RENEWAL_NOT_OPEN',
      );
    }

    if (tenant.renewal_vote_ends_at && tenant.renewal_vote_ends_at.getTime() < Date.now()) {
      // Vote window closed - trigger finalize
      await this.finalizeVotingPhase(tenant.id);
      throw new ConflictError('Voting window has closed', 'RENEWAL_VOTE_CLOSED');
    }

    const renewal = await tenureRenewalRepository.findMyVote(
      tenant.id,
      tenant.current_tenure,
      userId,
    );
    if (!renewal) {
      throw new NotFoundError('Renewal entry');
    }
    if (renewal.vote !== 'PENDING') {
      throw new ConflictError('You have already voted', 'RENEWAL_ALREADY_VOTED');
    }

    await withTransaction(async (tx) => {
      await tenureRenewalRepository.castVote(renewal.id, vote, tx);

      if (vote === 'NO') {
        // Remove membership immediately - slot freed for replacement.
        await tx.query(
          `UPDATE tenant_memberships SET status = 'REMOVED' WHERE id = $1`,
          [renewal.membership_id],
        );

        // Mark the tenant as REPLACING if not already.
        await tx.query(
          `UPDATE tenants
           SET renewal_state = 'REPLACING',
               renewal_fill_ends_at = COALESCE(
                 renewal_fill_ends_at,
                 NOW() + INTERVAL '${FILL_WINDOW_DAYS} days'
               )
           WHERE id = $1 AND renewal_state = 'VOTING'`,
          [tenant.id],
        );
      }
    });

    await record({
      actorId: userId,
      action: vote === 'YES' ? 'RENEWAL_VOTED_YES' : 'RENEWAL_VOTED_NO',
      entityType: 'tenant',
      entityId: tenant.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { slotNumber: renewal.slot_number },
    });

    logger.info(
      { tenantId: tenant.id, userId, vote, slot: renewal.slot_number },
      'Renewal vote cast',
    );

    // Try to finalize (in case this vote completes the set).
    await this.tryFinalize(tenant.id);

    return this.getStatus(tenant.id);
  }

  // ---------------------------------------------------------------
  // Step 3: finalize voting -> transition to REPLACING if any NO
  // ---------------------------------------------------------------

  /**
   * Called after every vote and on window expiry.
   * If all votes are YES -> tenure 2 begins immediately.
   * If any NO -> set fill window, state = REPLACING.
   */
  private async finalizeVotingPhase(tenantId: string): Promise<void> {
    const tenant = await tenantsRepository.findById(tenantId);
    if (!tenant) return;

    const counts = await tenureRenewalRepository.countVotes(
      tenantId,
      tenant.current_tenure,
    );

    // Everyone voted yes -> tenure 2 starts now
    if (counts.yes === 12) {
      await this.activateNextTenure(tenantId);
      return;
    }

    // If vote window has passed and some didn't vote -> treat non-votes as NO.
    if (
      counts.pending > 0 &&
      tenant.renewal_vote_ends_at &&
      tenant.renewal_vote_ends_at.getTime() <= Date.now()
    ) {
      await withTransaction(async (tx) => {
        await tx.query(
          `UPDATE tenure_renewals SET vote = 'NO', voted_at = NOW()
           WHERE tenant_id = $1 AND closing_tenure = $2 AND vote = 'PENDING'`,
          [tenantId, tenant.current_tenure],
        );

        await tx.query(
          `UPDATE tenant_memberships SET status = 'REMOVED'
           WHERE id IN (
             SELECT membership_id FROM tenure_renewals
             WHERE tenant_id = $1 AND closing_tenure = $2 AND vote = 'NO'
           )`,
          [tenantId, tenant.current_tenure],
        );

        await tx.query(
          `UPDATE tenants
           SET renewal_state = 'REPLACING',
               renewal_fill_ends_at = COALESCE(
                 renewal_fill_ends_at,
                 NOW() + INTERVAL '${FILL_WINDOW_DAYS} days'
               )
           WHERE id = $1`,
          [tenantId],
        );
      });
    }
  }

  // ---------------------------------------------------------------
  // Step 4: assign replacement when a new signup lands
  // ---------------------------------------------------------------

  /**
   * Called by provisioning service when a new user completes KYC.
   * Returns the tenant + slot if there's a REPLACING tenant waiting,
   * or null if the caller should fall through to normal provisioning.
   */
  async tryAssignReplacement(
    branchId: string,
    newUserId: string,
  ): Promise<{ tenantId: string; slotNumber: number } | null> {
    // Find a REPLACING tenant in this branch
    const result = await pool.query<TenantRow>(
      `SELECT * FROM tenants
       WHERE branch_id = $1 AND renewal_state = 'REPLACING'
       ORDER BY renewal_opened_at ASC
       LIMIT 1`,
      [branchId],
    );
    const tenant = result.rows[0];
    if (!tenant) return null;

    // Find an unfilled slot
    const unfilled = await tenureRenewalRepository.findUnfilledSlots(
      tenant.id,
      tenant.current_tenure,
    );
    if (unfilled.length === 0) return null;

    const slot = unfilled[0]!;

    try {
      await withTransaction(async (tx) => {
        // Create new membership for the replacement
        const membershipRes = await tx.query<TenantMembershipRow>(
          `INSERT INTO tenant_memberships
             (tenant_id, user_id, slot_number, tenure_joined, is_replacement_for_user_id)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [tenant.id, newUserId, slot.slot_number, tenant.current_tenure + 1, slot.user_id],
        );
        const membership = membershipRes.rows[0]!;

        // Update the renewal row
        await tenureRenewalRepository.markReplaced(
          slot.id,
          newUserId,
          membership.id,
          tx,
        );

        await record(
          {
            actorId: null,
            action: 'TENURE_REPLACEMENT_ASSIGNED',
            entityType: 'tenant',
            entityId: tenant.id,
            metadata: {
              slotNumber: slot.slot_number,
              oldUserId: slot.user_id,
              newUserId,
            },
          },
          tx,
        );
      });

      logger.info(
        { tenantId: tenant.id, newUserId, slot: slot.slot_number },
        'Replacement assigned to renewing tenant',
      );

      // Check if all slots are now filled
      await this.tryFinalize(tenant.id);

      return { tenantId: tenant.id, slotNumber: slot.slot_number };
    } catch (err) {
      logger.error({ err, tenantId: tenant.id, newUserId }, 'Replacement assignment failed');
      return null;
    }
  }

  // ---------------------------------------------------------------
  // Step 5: finalize -> either activate tenure 2, rebalance, or wait
  // ---------------------------------------------------------------

  private async tryFinalize(tenantId: string): Promise<void> {
    const tenant = await tenantsRepository.findById(tenantId);
    if (!tenant) return;
    if (tenant.renewal_state !== 'REPLACING') return;

    const unfilled = await tenureRenewalRepository.findUnfilledSlots(
      tenantId,
      tenant.current_tenure,
    );

    if (unfilled.length === 0) {
      await this.activateNextTenure(tenantId);
      return;
    }

    // Check if fill window expired -> attempt cross-tenant rebalance
    if (
      tenant.renewal_fill_ends_at &&
      tenant.renewal_fill_ends_at.getTime() <= Date.now()
    ) {
      await this.attemptCrossTenantRebalance(tenantId);
    }
  }

  // ---------------------------------------------------------------
  // Step 6: activate next tenure
  // ---------------------------------------------------------------

  private async activateNextTenure(tenantId: string): Promise<void> {
    await withTransaction(async (tx) => {
      // Lock tenant
      const lock = await tx.query<TenantRow>(
        `SELECT * FROM tenants WHERE id = $1 FOR UPDATE`,
        [tenantId],
      );
      const tenant = lock.rows[0];
      if (!tenant) throw new NotFoundError('Tenant');

      if (tenant.renewal_state === 'RENEWED') return; // already done

      const nextTenure = tenant.current_tenure + 1;

      // Reactivate the memberships that voted YES (they're still ACTIVE)
      // Members who voted NO were set to REMOVED - replacements are ACTIVE.
      // Nothing to do here besides resetting tenant to ACTIVE at cycle 1.
      await tx.query(
        `UPDATE tenants
         SET renewal_state = 'RENEWED',
             status = 'ACTIVE',
             current_tenure = $2,
             current_cycle = 1,
             cycle_started_at = NOW(),
             cycle_ends_at = NOW() + INTERVAL '30 days',
             cycle_contribution_deadline_at = NOW() + INTERVAL '21 days',
             cycle_payout_at = NOW() + INTERVAL '30 days',
             cycle_advanced_at = NULL,
             tenure_started_at = NOW(),
             renewal_opened_at = NULL,
             renewal_vote_ends_at = NULL,
             renewal_fill_ends_at = NULL,
             completed_at = NULL
         WHERE id = $1`,
        [tenantId, nextTenure],
      );

      await record(
        {
          actorId: null,
          action: 'TENURE_RENEWED',
          entityType: 'tenant',
          entityId: tenantId,
          metadata: { fromTenure: tenant.current_tenure, toTenure: nextTenure },
        },
        tx,
      );

      logger.info(
        { tenantId, fromTenure: tenant.current_tenure, toTenure: nextTenure },
        'Tenure renewed',
      );
    });

    // Generate cycle-1 intents for the new tenure (outside the tx - idempotent)
    const tenant = await tenantsRepository.findById(tenantId);
    if (tenant) {
      try {
        await rotationService.ensureIntentsForCycle(tenantId, tenant.current_tenure, 1);
      } catch (err) {
        logger.error({ err, tenantId }, 'Failed to generate tenure-2 cycle-1 intents');
      }
    }
  }

  // ---------------------------------------------------------------
  // Step 7: cross-tenant rebalance
  // ---------------------------------------------------------------

  private async attemptCrossTenantRebalance(tenantId: string): Promise<void> {
    const tenant = await tenantsRepository.findById(tenantId);
    if (!tenant) return;

    // Find FILLING tenants in the same branch (excluding this one)
    const fillingRes = await pool.query<TenantRow>(
      `SELECT * FROM tenants
       WHERE branch_id = $1 AND status = 'FILLING' AND id != $2
       ORDER BY created_at ASC`,
      [tenant.branch_id, tenantId],
    );
    const fillingTenants = fillingRes.rows;

    if (fillingTenants.length === 0) {
      logger.warn(
        { tenantId },
        'No FILLING tenants in branch - cannot rebalance; admin intervention required',
      );
      return;
    }

    const renewingActive = await tenantsRepository.findMembershipsByTenant(tenantId);
    const renewingCount = renewingActive.length;

    // Compute each FILLING tenant's member count.
    const fillingCounts: Array<{ tenant: TenantRow; count: number }> = [];
    for (const ft of fillingTenants) {
      const members = await tenantsRepository.findMembershipsByTenant(ft.id);
      fillingCounts.push({ tenant: ft, count: members.length });
    }
    fillingCounts.sort((a, b) => b.count - a.count);

    const highest = fillingCounts[0]!;

    if (renewingCount >= highest.count) {
      // Renewing has more (or equal) members -> pull from filling into renewing
      await this.pullFromFillingIntoRenewing(tenant, renewingCount, highest, fillingCounts);
    } else {
      // Filling has more -> push renewing members into filling
      await this.pushRenewingIntoFilling(tenant, renewingActive, highest);
    }
  }

  private async pullFromFillingIntoRenewing(
    renewingTenant: TenantRow,
    renewingCount: number,
    target: { tenant: TenantRow; count: number },
    _allFilling: Array<{ tenant: TenantRow; count: number }>,
  ): Promise<void> {
    const slotsNeeded = 12 - renewingCount;
    if (slotsNeeded <= 0) {
      await this.activateNextTenure(renewingTenant.id);
      return;
    }

    logger.info(
      {
        renewingTenantId: renewingTenant.id,
        slotsNeeded,
        sourceTenantId: target.tenant.id,
      },
      'Rebalance: pulling members from filling into renewing',
    );

    const sourceMembers = await tenantsRepository.findMembershipsByTenant(target.tenant.id);
    const unfilled = await tenureRenewalRepository.findUnfilledSlots(
      renewingTenant.id,
      renewingTenant.current_tenure,
    );

    let moved = 0;
    for (
      let i = 0;
      i < Math.min(slotsNeeded, sourceMembers.length, unfilled.length);
      i++
    ) {
      const fromMember = sourceMembers[i]!;
      const slot = unfilled[i]!;

      await withTransaction(async (tx) => {
        // Remove from source tenant
        await tx.query(
          `UPDATE tenant_memberships SET status = 'REMOVED' WHERE id = $1`,
          [fromMember.id],
        );

        // Insert into renewing tenant at the vacant slot
        const ins = await tx.query<TenantMembershipRow>(
          `INSERT INTO tenant_memberships
             (tenant_id, user_id, slot_number, tenure_joined, is_replacement_for_user_id)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [
            renewingTenant.id,
            fromMember.user_id,
            slot.slot_number,
            renewingTenant.current_tenure + 1,
            slot.user_id,
          ],
        );
        const newMembership = ins.rows[0]!;

        await tenureRenewalRepository.markReplaced(
          slot.id,
          fromMember.user_id,
          newMembership.id,
          tx,
        );

        await tenureRenewalRepository.logRebalance(
          {
            branchId: renewingTenant.branch_id,
            fromTenantId: target.tenant.id,
            toTenantId: renewingTenant.id,
            membershipId: newMembership.id,
            userId: fromMember.user_id,
            reason: 'REBALANCE_PULL_INTO_RENEWING',
          },
          tx,
        );
      });

      moved++;
    }

    logger.info(
      { renewingTenantId: renewingTenant.id, moved },
      'Rebalance pull complete',
    );

    await this.tryFinalize(renewingTenant.id);
  }

  private async pushRenewingIntoFilling(
    renewingTenant: TenantRow,
    renewingMembers: TenantMembershipRow[],
    target: { tenant: TenantRow; count: number },
  ): Promise<void> {
    const slotsAvailableInTarget = 12 - target.count;
    if (slotsAvailableInTarget <= 0) {
      logger.warn(
        { targetTenantId: target.tenant.id },
        'Rebalance target is full - cannot push',
      );
      return;
    }

    logger.info(
      {
        renewingTenantId: renewingTenant.id,
        targetTenantId: target.tenant.id,
        slotsAvailableInTarget,
        renewingMembers: renewingMembers.length,
      },
      'Rebalance: pushing renewing members into filling',
    );

    const used = await tenantsRepository.usedSlots(target.tenant.id);
    const freeSlots: number[] = [];
    for (let s = 1; s <= 12; s++) {
      if (!used.includes(s)) freeSlots.push(s);
    }

    const moveCount = Math.min(slotsAvailableInTarget, renewingMembers.length);

    for (let i = 0; i < moveCount; i++) {
      const member = renewingMembers[i]!;
      const slot = freeSlots[i]!;

      await withTransaction(async (tx) => {
        // Remove from renewing tenant
        await tx.query(
          `UPDATE tenant_memberships SET status = 'REMOVED' WHERE id = $1`,
          [member.id],
        );

        // Insert into filling tenant (fresh slot, tenure_joined=1 - that tenant's tenure)
        const ins = await tx.query<TenantMembershipRow>(
          `INSERT INTO tenant_memberships
             (tenant_id, user_id, slot_number, tenure_joined)
           VALUES ($1, $2, $3, 1)
           RETURNING *`,
          [target.tenant.id, member.user_id, slot],
        );
        const newMembership = ins.rows[0]!;

        await tenureRenewalRepository.logRebalance(
          {
            branchId: renewingTenant.branch_id,
            fromTenantId: renewingTenant.id,
            toTenantId: target.tenant.id,
            membershipId: newMembership.id,
            userId: member.user_id,
            reason: 'REBALANCE_PUSH_INTO_FILLING',
          },
          tx,
        );
      });
    }

    logger.info(
      {
        renewingTenantId: renewingTenant.id,
        targetTenantId: target.tenant.id,
        moved: moveCount,
      },
      'Rebalance push complete',
    );

    // If the renewing tenant is now empty (all members moved out), dissolve it.
    const remaining = await tenantsRepository.findMembershipsByTenant(renewingTenant.id);
    if (remaining.length === 0) {
      await this.dissolveTenant(
        renewingTenant.id,
        'All members transferred during rebalance',
      );
    } else if (remaining.length === 12) {
      await this.activateNextTenure(renewingTenant.id);
    } else {
      // Still short - admin must intervene
      logger.warn(
        { tenantId: renewingTenant.id, remaining: remaining.length },
        'Rebalance incomplete - admin intervention required',
      );
    }
  }

  // ---------------------------------------------------------------
  // Step 8: admin actions
  // ---------------------------------------------------------------

  async adminAssignReplacement(
    tenantId: string,
    slotNumber: number,
    newUserId: string,
    actorId: string,
    meta: RequestMeta,
  ): Promise<RenewalStatusDto> {
    const tenant = await tenantsRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');

    if (tenant.renewal_state !== 'REPLACING') {
      throw new ConflictError(
        `Tenant not in REPLACING state (state=${tenant.renewal_state})`,
        'RENEWAL_NOT_REPLACING',
      );
    }

    const slot = await tenureRenewalRepository.findPendingForSlot(
      tenantId,
      tenant.current_tenure,
      slotNumber,
    );
    if (!slot) {
      throw new NotFoundError(`No unfilled NO-vote slot ${slotNumber}`);
    }

    const newUser = await usersRepository.findById(newUserId);
    if (!newUser) throw new NotFoundError('Replacement user');
    if (newUser.branch_id !== tenant.branch_id) {
      throw new AppError({
        code: 'RENEWAL_WRONG_BRANCH',
        httpStatus: 400,
        message: 'Replacement user is not in this branch',
      });
    }

    const existingMembership = await tenantsRepository.findMembershipByUser(newUserId);
    if (existingMembership) {
      throw new ConflictError(
        'Replacement user is already in a tenant',
        'RENEWAL_USER_ALREADY_IN_TENANT',
      );
    }

    await withTransaction(async (tx) => {
      const ins = await tx.query<TenantMembershipRow>(
        `INSERT INTO tenant_memberships
           (tenant_id, user_id, slot_number, tenure_joined, is_replacement_for_user_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          tenantId,
          newUserId,
          slotNumber,
          tenant.current_tenure + 1,
          slot.user_id,
        ],
      );
      const newMembership = ins.rows[0]!;

      await tenureRenewalRepository.markReplaced(
        slot.id,
        newUserId,
        newMembership.id,
        tx,
      );
    });

    await record({
      actorId,
      action: 'TENURE_REPLACEMENT_ADMIN_ASSIGNED',
      entityType: 'tenant',
      entityId: tenantId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { slotNumber, newUserId },
    });

    logger.info({ tenantId, slotNumber, newUserId, actorId }, 'Admin assigned replacement');

    await this.tryFinalize(tenantId);
    return this.getStatus(tenantId);
  }

  async adminForceDissolve(
    tenantId: string,
    reason: string,
    actorId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const tenant = await tenantsRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');

    if (tenant.renewal_state === 'DISSOLVED') return;

    await record({
      actorId,
      action: 'TENURE_RENEWAL_ADMIN_DISSOLVED',
      entityType: 'tenant',
      entityId: tenantId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { reason, previousState: tenant.renewal_state },
    });

    await this.dissolveTenant(tenantId, reason);
  }

  private async dissolveTenant(tenantId: string, reason: string): Promise<void> {
    await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE tenants
         SET renewal_state = 'DISSOLVED',
             status = 'COMPLETED',
             completed_at = NOW()
         WHERE id = $1`,
        [tenantId],
      );

      await tx.query(
        `UPDATE tenant_memberships
         SET status = 'REMOVED'
         WHERE tenant_id = $1 AND status != 'REMOVED'`,
        [tenantId],
      );

      await record(
        {
          actorId: null,
          action: 'TENANT_DISSOLVED',
          entityType: 'tenant',
          entityId: tenantId,
          metadata: { reason },
        },
        tx,
      );
    });

    logger.info({ tenantId, reason }, 'Tenant dissolved');
  }

  // ---------------------------------------------------------------
  // Read APIs
  // ---------------------------------------------------------------

  async getStatus(tenantId: string): Promise<RenewalStatusDto> {
    const tenant = await tenantsRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');

    const counts = await tenureRenewalRepository.countVotes(
      tenantId,
      tenant.current_tenure,
    );

    const unfilled = await tenureRenewalRepository.findUnfilledSlots(
      tenantId,
      tenant.current_tenure,
    );

    return {
      tenantId,
      renewalState: tenant.renewal_state,
      closingTenure: tenant.current_tenure,
      nextTenure: tenant.current_tenure + 1,
      voteEndsAt: tenant.renewal_vote_ends_at?.toISOString() ?? null,
      fillEndsAt: tenant.renewal_fill_ends_at?.toISOString() ?? null,
      yesCount: counts.yes,
      noCount: counts.no,
      pendingCount: counts.pending,
      replacedCount: counts.replaced,
      unfilledSlots: unfilled.map((u) => u.slot_number),
    };
  }

  async getMyRenewal(userId: string): Promise<{
    status: RenewalStatusDto;
    myVote: 'PENDING' | 'YES' | 'NO' | null;
    mySlot: number | null;
  } | null> {
    const membership = await tenantsRepository.findMembershipByUser(userId);
    if (!membership) return null;

    const tenant = await tenantsRepository.findById(membership.tenant_id);
    if (!tenant) return null;
    if (tenant.renewal_state === 'NONE') return null;

    const renewal = await tenureRenewalRepository.findMyVote(
      tenant.id,
      tenant.current_tenure,
      userId,
    );

    return {
      status: await this.getStatus(tenant.id),
      myVote: renewal?.vote ?? null,
      mySlot: renewal?.slot_number ?? null,
    };
  }

  async listMembers(tenantId: string): Promise<RenewalMemberDto[]> {
    const tenant = await tenantsRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');

    const rows = await tenureRenewalRepository.listMembersForRenewal(
      tenantId,
      tenant.current_tenure,
    );

    return rows.map((r) => ({
      renewalId: r.renewal_id,
      userId: r.user_id,
      fullName: r.full_name,
      slotNumber: r.slot_number,
      vote: r.vote,
      votedAt: r.voted_at?.toISOString() ?? null,
      replacementUserId: r.replacement_user_id,
      replacementName: r.replacement_name,
      replacedAt: r.replaced_at?.toISOString() ?? null,
    }));
  }

  /**
   * Lazy trigger: called when a member loads their dashboard.
   * Checks if the vote or fill window has expired and finalizes.
   */
  async lazyCheckForUser(userId: string): Promise<void> {
    const membership = await tenantsRepository.findMembershipByUser(userId);
    if (!membership) return;

    const tenant = await tenantsRepository.findById(membership.tenant_id);
    if (!tenant) return;
    if (
      tenant.renewal_state === 'NONE' ||
      tenant.renewal_state === 'RENEWED' ||
      tenant.renewal_state === 'DISSOLVED'
    ) {
      return;
    }

    if (
      tenant.renewal_state === 'VOTING' &&
      tenant.renewal_vote_ends_at &&
      tenant.renewal_vote_ends_at.getTime() <= Date.now()
    ) {
      await this.finalizeVotingPhase(tenant.id);
    }

    if (
      tenant.renewal_state === 'REPLACING' &&
      tenant.renewal_fill_ends_at &&
      tenant.renewal_fill_ends_at.getTime() <= Date.now()
    ) {
      await this.tryFinalize(tenant.id);
    }
  }
}

export const tenureRenewalService = new TenureRenewalService();