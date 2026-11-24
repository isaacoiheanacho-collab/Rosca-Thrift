import { pool } from '../../db';
import { AppError, ConflictError, NotFoundError } from '../../errors';

export type ContributionFrequency = 'WEEKLY' | 'MONTHLY';

export interface CircleConfiguration {
  id: string;
  branch_id: string;
  name: string;
  contribution_amount: string;
  contribution_frequency: ContributionFrequency;
  member_capacity: number;
  collection_positions: number;
  contribution_window_days: number;
  cycle_duration_days: number;
  created_at: Date;
}

export interface CreateCircleConfigurationInput {
  name: string;
  contributionAmountPence: string;
  contributionFrequency: ContributionFrequency;
  memberCapacity: number;
  contributionWindowDays: number;
  cycleDurationDays: number;
}

export class CircleConfigurationsService {
  async listPublic(branchSlug: string) {
    const branch = await pool.query<{ id: string; status: string }>(
      'SELECT id, status FROM branches WHERE slug = $1', [branchSlug],
    );
    if (!branch.rows[0] || branch.rows[0].status !== 'ACTIVE') {
      throw new NotFoundError('Branch');
    }
    const result = await pool.query<CircleConfiguration>(
      `SELECT id, branch_id, name, contribution_amount::text,
              contribution_frequency, member_capacity, collection_positions,
              contribution_window_days, cycle_duration_days, created_at
       FROM circle_configurations
       WHERE branch_id = $1 AND (is_legacy = FALSE OR NOT EXISTS (SELECT 1 FROM circle_configurations c2 WHERE c2.branch_id = $1 AND c2.is_legacy = FALSE))
       ORDER BY created_at ASC`,
      [branch.rows[0].id],
    );
    return result.rows.map((row) => this.toDto(row));
  }

  async listForAdmin(branchId: string) {
    const result = await pool.query<CircleConfiguration>(
      `SELECT c.*,
        (SELECT COUNT(*)::int FROM tenants t WHERE t.configuration_id = c.id) AS tenant_count,
        (SELECT COUNT(*)::int FROM tenants t WHERE t.configuration_id = c.id AND t.status = 'FILLING') AS filling_count
       FROM circle_configurations c
       WHERE c.branch_id = $1
       ORDER BY c.created_at ASC`,
      [branchId],
    );
    return result.rows.map((row) => this.toDto(row));
  }

  async create(branchId: string, input: CreateCircleConfigurationInput, actorId: string) {
    const branch = await pool.query('SELECT id FROM branches WHERE id = $1', [branchId]);
    if (!branch.rowCount) throw new NotFoundError('Branch');
    const amount = BigInt(input.contributionAmountPence);
    if (amount <= 0n) throw new AppError({code:'CIRCLE_AMOUNT_INVALID',httpStatus:400,message:'Contribution amount must be greater than zero'});
    if (input.memberCapacity < 2 || input.memberCapacity > 100) {
      throw new AppError({code:'CIRCLE_CAPACITY_INVALID',httpStatus:400,message:'Co-saver capacity must be between 2 and 100'});
    }
    const duplicate = await pool.query(
      `SELECT id FROM circle_configurations
       WHERE branch_id = $1
         AND contribution_amount = $2 AND contribution_frequency = $3
         AND member_capacity = $4 AND contribution_window_days = $5
         AND cycle_duration_days = $6`,
      [branchId, amount.toString(), input.contributionFrequency, input.memberCapacity,
       input.contributionWindowDays, input.cycleDurationDays],
    );
    if (duplicate.rowCount) {
      throw new ConflictError('A configuration with these material settings already exists', 'CIRCLE_CONFIGURATION_DUPLICATE');
    }
    try {
      const result = await pool.query<CircleConfiguration>(
        `INSERT INTO circle_configurations
          (branch_id, name, contribution_amount, contribution_frequency,
           member_capacity, collection_positions, contribution_window_days,
           cycle_duration_days, created_by)
         VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8)
         RETURNING id, branch_id, name, contribution_amount::text,
                   contribution_frequency, member_capacity, collection_positions,
                   contribution_window_days, cycle_duration_days, created_at`,
        [branchId, input.name.trim(), amount.toString(), input.contributionFrequency,
         input.memberCapacity, input.contributionWindowDays, input.cycleDurationDays, actorId],
      );
      return this.toDto(result.rows[0]);
    } catch (error: any) {
      if (error?.code === '23505') {
        throw new ConflictError('A configuration with these material settings already exists', 'CIRCLE_CONFIGURATION_DUPLICATE');
      }
      throw error;
    }
  }

  private toDto(row: any) {
    return {
      id: row.id,
      branchId: row.branch_id,
      name: row.name,
      contributionAmountPence: row.contribution_amount,
      contributionFrequency: row.contribution_frequency,
      payoutFrequency: row.contribution_frequency,
      memberCapacity: row.member_capacity,
      collectionPositions: row.collection_positions,
      contributionWindowDays: row.contribution_window_days,
      cycleDurationDays: row.cycle_duration_days,
      tenantCount: row.tenant_count === undefined ? undefined : Number(row.tenant_count),
      fillingCount: row.filling_count === undefined ? undefined : Number(row.filling_count),
      createdAt: row.created_at.toISOString(),
    };
  }
}

export const circleConfigurationsService = new CircleConfigurationsService();
