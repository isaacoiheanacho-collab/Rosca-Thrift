-- =============================================================================
-- 009_ledger.sql
-- Append-only ledger entries. Every credit and debit to a tenant pool
-- and to the platform maintenance account is recorded here.
--
-- Rules:
--   - Append-only. No UPDATE. No DELETE. Enforced by trigger.
--   - One entry per money movement (contribution, payout, fee, adjustment).
--   - Every entry has a reference that matches the bank-transfer reference.
--   - Balance is derivable by SUM(), and materialized in balance_after.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ledger_entries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What pot does this affect?
  --   TENANT      : a specific tenant's pool (contributions, payouts, TVC)
  --   BRANCH_FEE  : the branch's fee-payment ledger (tracking what branch paid to platform)
  --   PLATFORM    : the platform maintenance account ledger
  account_type      TEXT NOT NULL CHECK (account_type IN ('TENANT', 'BRANCH_FEE', 'PLATFORM')),

  -- Foreign keys (only the relevant one is set based on account_type)
  tenant_id         UUID REFERENCES tenants(id) ON DELETE RESTRICT,
  branch_id         UUID REFERENCES branches(id) ON DELETE RESTRICT,

  -- CREDIT = money in, DEBIT = money out
  entry_type        TEXT NOT NULL CHECK (entry_type IN ('CREDIT', 'DEBIT')),

  -- Amount in pence (always positive; entry_type determines direction)
  amount            BIGINT NOT NULL CHECK (amount > 0),
  currency          TEXT NOT NULL DEFAULT 'GBP',

  -- Reference on the bank transfer (e.g. INfdae97040103)
  reference         TEXT NOT NULL,

  -- What kind of movement is this?
  --   CONTRIBUTION  : saver → tenant pool
  --   PAYOUT        : tenant pool → saver
  --   PLATFORM_FEE  : branch → platform maintenance
  --   TVC_ADJUSTMENT: time-value adjustment (adds to or subtracts from pot)
  --   ADJUSTMENT    : manual correction by super admin
  entry_kind        TEXT NOT NULL CHECK (entry_kind IN (
    'CONTRIBUTION', 'PAYOUT', 'PLATFORM_FEE', 'TVC_ADJUSTMENT', 'ADJUSTMENT'
  )),

  -- Link to the source row that created this entry
  contribution_id   UUID REFERENCES contributions(id) ON DELETE RESTRICT,
  payout_id         UUID, -- FK added later when payouts table is created
  -- (no FK for TVC or ADJUSTMENT — they're standalone)

  -- Optional context
  description       TEXT,

  -- Audit
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_tenant      ON ledger_entries (tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_branch      ON ledger_entries (branch_id) WHERE branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_account     ON ledger_entries (account_type);
CREATE INDEX IF NOT EXISTS idx_ledger_reference   ON ledger_entries (reference);
CREATE INDEX IF NOT EXISTS idx_ledger_kind        ON ledger_entries (entry_kind);
CREATE INDEX IF NOT EXISTS idx_ledger_created     ON ledger_entries (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_contribution ON ledger_entries (contribution_id) WHERE contribution_id IS NOT NULL;

-- Prevent UPDATE and DELETE on ledger_entries
CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_no_update ON ledger_entries;
CREATE TRIGGER trg_ledger_no_update
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();