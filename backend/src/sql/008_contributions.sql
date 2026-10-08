-- =============================================================================
-- 008_contributions.sql
-- Contribution intents, confirmed contributions, and uploaded receipts.
--
-- Flow:
--   1. Saver generates an intent → gets reference + branch bank details
--   2. Saver transfers money from their own bank
--   3. Saver uploads receipt → linked to the intent
--   4. Branch admin verifies receipt → confirms → contribution row created
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Contribution intents — a saver's declaration to pay for a specific cycle.
-- Generated when cycle begins. One row per member per cycle.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contribution_intents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  membership_id     UUID NOT NULL REFERENCES tenant_memberships(id) ON DELETE CASCADE,

  branch_id         UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,

  -- Cycle position
  tenure            INT NOT NULL DEFAULT 1,
  cycle             INT NOT NULL CHECK (cycle BETWEEN 1 AND 12),
  slot_number       INT NOT NULL CHECK (slot_number BETWEEN 1 AND 12),

  -- Reference (unique across the platform) e.g. ROSCA-C5-T1-P7-M3
  reference         TEXT NOT NULL UNIQUE,

  -- Expected amount in pence (from platform constants)
  expected_amount   BIGINT NOT NULL,

  -- Deadline for contribution (day 21 of the cycle)
  deadline_at       TIMESTAMPTZ NOT NULL,

  -- Computed state — updated by a scheduled job or on-read
  --   pending   : before deadline, no contribution yet
  --   confirmed : contribution recorded
  --   late      : past deadline, no contribution recorded
  --   exempt    : admin marked member exempt for this cycle
  state             TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (state IN ('PENDING', 'CONFIRMED', 'LATE', 'EXEMPT')),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_intents_tenant_cycle ON contribution_intents (tenant_id, cycle);
CREATE INDEX IF NOT EXISTS idx_intents_user          ON contribution_intents (user_id);
CREATE INDEX IF NOT EXISTS idx_intents_state         ON contribution_intents (state);
CREATE INDEX IF NOT EXISTS idx_intents_deadline      ON contribution_intents (deadline_at);
CREATE INDEX IF NOT EXISTS idx_intents_reference     ON contribution_intents (reference);

-- One intent per (tenant, tenure, cycle, user)
CREATE UNIQUE INDEX IF NOT EXISTS uq_intent_tenant_tenure_cycle_user
  ON contribution_intents (tenant_id, tenure, cycle, user_id);

DROP TRIGGER IF EXISTS trg_intents_updated_at ON contribution_intents;
CREATE TRIGGER trg_intents_updated_at
  BEFORE UPDATE ON contribution_intents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Contributions — recorded when admin confirms a receipt.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contributions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  membership_id         UUID NOT NULL REFERENCES tenant_memberships(id) ON DELETE CASCADE,
  intent_id             UUID NOT NULL REFERENCES contribution_intents(id) ON DELETE RESTRICT,
  branch_id             UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,

  -- Cycle snapshot (matches intent)
  tenure                INT NOT NULL,
  cycle                 INT NOT NULL CHECK (cycle BETWEEN 1 AND 12),
  slot_number           INT NOT NULL CHECK (slot_number BETWEEN 1 AND 12),
  reference             TEXT NOT NULL,

  -- Money
  amount                BIGINT NOT NULL CHECK (amount > 0),
  currency              TEXT NOT NULL DEFAULT 'GBP',

  -- Verification audit
  confirmed_by          UUID NOT NULL REFERENCES users(id),
  confirmed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Optional note from admin (e.g. "£10 short, verified by agreement")
  admin_note            TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contrib_tenant_cycle ON contributions (tenant_id, cycle);
CREATE INDEX IF NOT EXISTS idx_contrib_user          ON contributions (user_id);
CREATE INDEX IF NOT EXISTS idx_contrib_intent        ON contributions (intent_id);
CREATE INDEX IF NOT EXISTS idx_contrib_confirmed_at  ON contributions (confirmed_at);

-- One contribution per intent (a saver can't double-pay for the same cycle)
CREATE UNIQUE INDEX IF NOT EXISTS uq_contribution_intent
  ON contributions (intent_id);

-- ---------------------------------------------------------------------------
-- Receipts — uploaded by savers (for contributions) and branch admins (for payouts).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS receipts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What this receipt proves
  purpose               TEXT NOT NULL
                        CHECK (purpose IN ('CONTRIBUTION', 'PAYOUT', 'PLATFORM_FEE')),

  -- Link (only one of these should be set)
  intent_id             UUID REFERENCES contribution_intents(id) ON DELETE CASCADE,
  contribution_id       UUID REFERENCES contributions(id) ON DELETE CASCADE,
  payout_id             UUID, -- FK added in the payouts migration later

  -- Who uploaded
  uploaded_by           UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  branch_id             UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,

  -- Storage
  object_key            TEXT NOT NULL,          -- B2 object key, not URL
  file_name             TEXT NOT NULL,
  mime_type             TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/heic')),
  size_bytes            BIGINT NOT NULL,

  -- Saver-supplied data at upload time
  claimed_amount        BIGINT,
  claimed_reference     TEXT,
  claimed_sender_name   TEXT,
  claimed_note          TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Exactly one of intent_id / contribution_id / payout_id must be set
  CONSTRAINT receipt_link_exactly_one CHECK (
    (CASE WHEN intent_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN contribution_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN payout_id IS NOT NULL THEN 1 ELSE 0 END) = 1
  )
);

CREATE INDEX IF NOT EXISTS idx_receipts_intent         ON receipts (intent_id) WHERE intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_receipts_contribution   ON receipts (contribution_id) WHERE contribution_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_receipts_branch         ON receipts (branch_id);
CREATE INDEX IF NOT EXISTS idx_receipts_uploaded_by    ON receipts (uploaded_by);
CREATE INDEX IF NOT EXISTS idx_receipts_created_at     ON receipts (created_at DESC);