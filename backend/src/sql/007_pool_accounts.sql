-- =============================================================================
-- 007_pool_accounts.sql
-- Branch pool account details + platform maintenance account.
-- No OAuth, no tokens. Informational only — admin verifies receipts manually.
-- =============================================================================

CREATE TABLE IF NOT EXISTS branch_pool_accounts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id             UUID NOT NULL UNIQUE REFERENCES branches(id) ON DELETE CASCADE,

  account_holder_name   TEXT NOT NULL,
  bank_name             TEXT NOT NULL,
  account_number        TEXT NOT NULL,
  sort_code             TEXT NOT NULL,

  notes                 TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pool_accounts_branch ON branch_pool_accounts (branch_id);

DROP TRIGGER IF EXISTS trg_pool_accounts_updated_at ON branch_pool_accounts;
CREATE TRIGGER trg_pool_accounts_updated_at
  BEFORE UPDATE ON branch_pool_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS platform_maintenance_account (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton             BOOLEAN NOT NULL DEFAULT TRUE UNIQUE CHECK (singleton),

  account_holder_name   TEXT NOT NULL,
  bank_name             TEXT NOT NULL,
  account_number        TEXT NOT NULL,
  sort_code             TEXT NOT NULL,

  notes                 TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_maintenance_account_updated_at ON platform_maintenance_account;
CREATE TRIGGER trg_maintenance_account_updated_at
  BEFORE UPDATE ON platform_maintenance_account
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();