-- =============================================================================
-- 024_tvc_account.sql
-- Adds the TVC account to ledger_entries so early-collector penalties can be
-- pooled and later distributed to late collectors in the same tenant.
--
-- The TVC pool is a per-tenant virtual account:
--   CREDIT  = penalty collected from an early collector (slots 1-6)
--   DEBIT   = bonus paid out to a late collector (slots 8-12)
--
-- Over a full tenure, credits and debits balance to £0, exactly matching the
-- symmetric TVC formula in calculateTvc().
-- =============================================================================

-- Drop the old constraint (only allowed TENANT, BRANCH_FEE, PLATFORM)
ALTER TABLE ledger_entries
  DROP CONSTRAINT IF EXISTS ledger_entries_account_type_check;

-- Add the new constraint including TVC
ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_account_type_check
  CHECK (account_type IN ('TENANT', 'BRANCH_FEE', 'PLATFORM', 'TVC'));

-- Optional: index for fast TVC pool balance lookups (per tenant)
CREATE INDEX IF NOT EXISTS idx_ledger_tvc_balance
  ON ledger_entries (tenant_id, entry_type)
  WHERE account_type = 'TVC';