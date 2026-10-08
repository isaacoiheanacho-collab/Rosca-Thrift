/**
 * Pool accounts repository.
 */

import { pool } from '../../db';

export interface BranchPoolAccountRow {
  id: string;
  branch_id: string;
  account_holder_name: string;
  bank_name: string;
  account_number: string;
  sort_code: string;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PlatformMaintenanceAccountRow {
  id: string;
  singleton: boolean;
  account_holder_name: string;
  bank_name: string;
  account_number: string;
  sort_code: string;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export class PoolAccountsRepository {
  async findBranchAccount(branchId: string): Promise<BranchPoolAccountRow | null> {
    const result = await pool.query<BranchPoolAccountRow>(
      'SELECT * FROM branch_pool_accounts WHERE branch_id = $1',
      [branchId],
    );
    return result.rows[0] ?? null;
  }

  async upsertBranchAccount(
    branchId: string,
    data: {
      accountHolderName: string;
      bankName: string;
      accountNumber: string;
      sortCode: string;
      notes?: string;
    },
  ): Promise<BranchPoolAccountRow> {
    const result = await pool.query<BranchPoolAccountRow>(
      `INSERT INTO branch_pool_accounts
         (branch_id, account_holder_name, bank_name, account_number, sort_code, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (branch_id) DO UPDATE SET
         account_holder_name = EXCLUDED.account_holder_name,
         bank_name = EXCLUDED.bank_name,
         account_number = EXCLUDED.account_number,
         sort_code = EXCLUDED.sort_code,
         notes = EXCLUDED.notes
       RETURNING *`,
      [
        branchId,
        data.accountHolderName,
        data.bankName,
        data.accountNumber,
        data.sortCode,
        data.notes ?? null,
      ],
    );
    return result.rows[0]!;
  }

  async findPlatformMaintenanceAccount(): Promise<PlatformMaintenanceAccountRow | null> {
    const result = await pool.query<PlatformMaintenanceAccountRow>(
      'SELECT * FROM platform_maintenance_account LIMIT 1',
    );
    return result.rows[0] ?? null;
  }

  async upsertPlatformMaintenanceAccount(data: {
    accountHolderName: string;
    bankName: string;
    accountNumber: string;
    sortCode: string;
    notes?: string;
  }): Promise<PlatformMaintenanceAccountRow> {
    const existing = await this.findPlatformMaintenanceAccount();
    if (existing) {
      const result = await pool.query<PlatformMaintenanceAccountRow>(
        `UPDATE platform_maintenance_account
         SET account_holder_name = $1, bank_name = $2, account_number = $3,
             sort_code = $4, notes = $5
         WHERE id = $6
         RETURNING *`,
        [
          data.accountHolderName,
          data.bankName,
          data.accountNumber,
          data.sortCode,
          data.notes ?? null,
          existing.id,
        ],
      );
      return result.rows[0]!;
    }
    const result = await pool.query<PlatformMaintenanceAccountRow>(
      `INSERT INTO platform_maintenance_account
         (account_holder_name, bank_name, account_number, sort_code, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        data.accountHolderName,
        data.bankName,
        data.accountNumber,
        data.sortCode,
        data.notes ?? null,
      ],
    );
    return result.rows[0]!;
  }
}

export const poolAccountsRepository = new PoolAccountsRepository();