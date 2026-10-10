-- =============================================================================
-- 012_payouts.sql
-- Payout intents + platform fee intents + tenure rate snapshots.
--
-- Model:
--   - Each cycle, one member receives the pool (their slot number = cycle number).
--   - Payout amount = gross pot + TVC adjustment − platform fee.
--   - TVC adjustment rewards late collectors, penalizes early collectors.
--   - Platform fee = 1.5% of post-TVC pot.
--   - Rates are LOCKED at tenure start (snapshot on tenants + payout_intents).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Add tenure rate snapshots to tenants
-- ---------------------------------------------------------------------------
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS current_tenure_fee_bps INT NOT NULL DEFAULT 150
  CHECK (current_tenure_fee_bps >= 0 AND current_tenure_fee_bps <= 10000);

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS current_tenure_tvc_bps INT NOT NULL DEFAULT 200
  CHECK (current_tenure_tvc_bps >= 0 AND current_tenure_tvc_bps <= 10000);

-- Backfill existing tenants (test data) with defaults
UPDATE tenants SET current_tenure_fee_bps = 150 WHERE current_tenure_fee_bps IS NULL;
UPDATE tenants SET current_tenure_tvc_bps = 200 WHERE current_tenure_tvc_bps IS NULL;

-- ---------------------------------------------------------------------------
-- Platform fee intents — one per (tenant, tenure, cycle).
-- The branch admin pays this separately (to the platform maintenance account)
-- before the payout is unlocked.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_fee_intents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id       UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,

  tenure          INT NOT NULL,
  cycle           INT NOT NULL CHECK (cycle BETWEEN 1 AND 12),

  -- Reference the branch admin uses on the bank transfer (FEE{tenant6}{tenure2})
  reference       TEXT NOT NULL,

  -- Amount in pence
  amount          BIGINT NOT NULL CHECK (amount >= 0),
  currency        TEXT NOT NULL DEFAULT 'GBP',

  -- Fee rate snapshot
  fee_bps         INT NOT NULL,

  -- Workflow
  --   PENDING          : awaiting branch payment
  --   RECEIPT_UPLOADED : branch uploaded a receipt
  --   CONFIRMED        : super admin verified receipt
  state           TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (state IN ('PENDING', 'RECEIPT_UPLOADED', 'CONFIRMED')),

  -- Confirmed by super admin
  confirmed_by    UUID REFERENCES users(id),
  confirmed_at    TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_fee_intent_tenant_tenure_cycle
    UNIQUE (tenant_id, tenure, cycle)
);

CREATE INDEX IF NOT EXISTS idx_fee_intents_tenant      ON platform_fee_intents (tenant_id);
CREATE INDEX IF NOT EXISTS idx_fee_intents_branch      ON platform_fee_intents (branch_id);
CREATE INDEX IF NOT EXISTS idx_fee_intents_state       ON platform_fee_intents (state);
CREATE INDEX IF NOT EXISTS idx_fee_intents_reference   ON platform_fee_intents (reference);

DROP TRIGGER IF EXISTS trg_fee_intents_updated_at ON platform_fee_intents;
CREATE TRIGGER trg_fee_intents_updated_at
  BEFORE UPDATE ON platform_fee_intents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Payout intents — one per (tenant, tenure, cycle).
-- Records the recipient, gross amount, TVC adjustment, platform fee, net.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payout_intents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id       UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,

  tenure          INT NOT NULL,
  cycle           INT NOT NULL CHECK (cycle BETWEEN 1 AND 12),

  -- Recipient (the member whose slot matches the cycle)
  recipient_user_id       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recipient_membership_id UUID NOT NULL REFERENCES tenant_memberships(id) ON DELETE RESTRICT,
  recipient_slot          INT NOT NULL CHECK (recipient_slot BETWEEN 1 AND 12),

  -- Reference the branch admin uses on the bank transfer (OUT{tenant6}{slot2}{tenure2}{cycle2})
  reference       TEXT NOT NULL,

  -- Money (all in pence)
  gross_amount    BIGINT NOT NULL CHECK (gross_amount > 0),       -- 12,000_00
  tvc_adjustment  BIGINT NOT NULL,                                 -- signed, e.g. -110_00
  pot_after_tvc   BIGINT NOT NULL CHECK (pot_after_tvc > 0),       -- gross + tvc
  platform_fee    BIGINT NOT NULL CHECK (platform_fee >= 0),       -- 1.5% of pot_after_tvc
  net_amount      BIGINT NOT NULL CHECK (net_amount > 0),          -- pot_after_tvc - fee
  currency        TEXT NOT NULL DEFAULT 'GBP',

  -- Rate snapshots (immutable — recorded at intent creation)
  tvc_bps         INT NOT NULL,
  fee_bps         INT NOT NULL,

  -- Workflow
  --   PENDING          : waiting for platform fee to be confirmed
  --   FEE_PAID         : fee confirmed, payout unlocked for branch admin
  --   RECEIPT_UPLOADED : branch admin uploaded payout receipt
  --   CONFIRMED        : super admin verified payout receipt, ledger debited
  state           TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (state IN ('PENDING', 'FEE_PAID', 'RECEIPT_UPLOADED', 'CONFIRMED')),

  -- Fee confirmation (unlocks payout)
  fee_confirmed_by  UUID REFERENCES users(id),
  fee_confirmed_at  TIMESTAMPTZ,

  -- Payout confirmation
  payout_confirmed_by UUID REFERENCES users(id),
  payout_confirmed_at TIMESTAMPTZ,

  -- Links to the fee intent for this cycle
  fee_intent_id   UUID REFERENCES platform_fee_intents(id) ON DELETE RESTRICT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_payout_intent_tenant_tenure_cycle
    UNIQUE (tenant_id, tenure, cycle)
);

CREATE INDEX IF NOT EXISTS idx_payout_intents_tenant      ON payout_intents (tenant_id);
CREATE INDEX IF NOT EXISTS idx_payout_intents_branch      ON payout_intents (branch_id);
CREATE INDEX IF NOT EXISTS idx_payout_intents_recipient   ON payout_intents (recipient_user_id);
CREATE INDEX IF NOT EXISTS idx_payout_intents_state       ON payout_intents (state);
CREATE INDEX IF NOT EXISTS idx_payout_intents_reference   ON payout_intents (reference);

DROP TRIGGER IF EXISTS trg_payout_intents_updated_at ON payout_intents;
CREATE TRIGGER trg_payout_intents_updated_at
  BEFORE UPDATE ON payout_intents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Add FK from ledger_entries.payout_id to payout_intents.id (was deferred
-- in migration 009 when payouts table didn't exist yet).
-- ---------------------------------------------------------------------------
ALTER TABLE ledger_entries
  DROP CONSTRAINT IF EXISTS ledger_entries_payout_id_fkey;

ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_payout_id_fkey
  FOREIGN KEY (payout_id) REFERENCES payout_intents(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Add FK from receipts.payout_id to payout_intents.id
-- ---------------------------------------------------------------------------
ALTER TABLE receipts
  DROP CONSTRAINT IF EXISTS receipts_payout_id_fkey;

ALTER TABLE receipts
  ADD CONSTRAINT receipts_payout_id_fkey
  FOREIGN KEY (payout_id) REFERENCES payout_intents(id) ON DELETE CASCADE;