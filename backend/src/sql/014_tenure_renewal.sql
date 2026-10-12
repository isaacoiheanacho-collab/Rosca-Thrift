-- =============================================================================
-- 014_tenure_renewal.sql
-- Tenure renewal voting + slot replacement + cross-tenant rebalancing.
--
-- Flow:
--   1. Cycle 12 payout confirmed → tenant status = COMPLETED, renewal opened
--   2. 12 tenure_renewals rows created (one per member), state = PENDING
--   3. Members vote YES or NO
--      - YES  → stays for tenure 2
--      - NO   → membership removed, slot freed immediately for replacement
--   4. Voting window = 7 days
--   5. If any NO votes: fill window = 7 days from first NO
--      - New signups in branch prioritized to renewing tenant
--      - If window expires without fill: cross-tenant rebalance
--   6. When 12 slots confirmed → tenure 2 begins, same slot numbers, new cycle 1
--   7. If rebalance can't fill → tenant stays in REPLACING, admin notified
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tenant: renewal state tracking
-- ---------------------------------------------------------------------------
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS renewal_state TEXT NOT NULL DEFAULT 'NONE'
  CHECK (renewal_state IN ('NONE', 'VOTING', 'REPLACING', 'READY', 'RENEWED', 'DISSOLVED'));

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS renewal_opened_at TIMESTAMPTZ;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS renewal_vote_ends_at TIMESTAMPTZ;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS renewal_fill_ends_at TIMESTAMPTZ;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS tenure_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tenants_renewal_state
  ON tenants (renewal_state) WHERE renewal_state != 'NONE';

-- ---------------------------------------------------------------------------
-- Tenant memberships: track which tenure each membership belongs to
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_memberships
  ADD COLUMN IF NOT EXISTS tenure_joined INT NOT NULL DEFAULT 1;

ALTER TABLE tenant_memberships
  ADD COLUMN IF NOT EXISTS is_replacement_for_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Tenure renewals: one row per member per renewal cycle
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenure_renewals (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  closing_tenure           INT NOT NULL,
  next_tenure              INT NOT NULL,

  user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  membership_id            UUID NOT NULL REFERENCES tenant_memberships(id) ON DELETE CASCADE,
  slot_number              INT NOT NULL CHECK (slot_number BETWEEN 1 AND 12),

  vote                     TEXT NOT NULL DEFAULT 'PENDING'
                           CHECK (vote IN ('PENDING', 'YES', 'NO')),

  voted_at                 TIMESTAMPTZ,

  -- Replacement tracking
  replacement_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  replacement_membership_id UUID REFERENCES tenant_memberships(id) ON DELETE SET NULL,
  replaced_at              TIMESTAMPTZ,

  -- Rebalance tracking (if this member was moved to another tenant)
  moved_to_tenant_id       UUID REFERENCES tenants(id) ON DELETE SET NULL,
  moved_at                 TIMESTAMPTZ,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_tenure_renewal_membership
    UNIQUE (tenant_id, closing_tenure, membership_id)
);

CREATE INDEX IF NOT EXISTS idx_tenure_renewals_tenant
  ON tenure_renewals (tenant_id, closing_tenure);
CREATE INDEX IF NOT EXISTS idx_tenure_renewals_user
  ON tenure_renewals (user_id);
CREATE INDEX IF NOT EXISTS idx_tenure_renewals_vote
  ON tenure_renewals (tenant_id, vote);
CREATE INDEX IF NOT EXISTS idx_tenure_renewals_slot
  ON tenure_renewals (tenant_id, slot_number);

DROP TRIGGER IF EXISTS trg_tenure_renewals_updated_at ON tenure_renewals;
CREATE TRIGGER trg_tenure_renewals_updated_at
  BEFORE UPDATE ON tenure_renewals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Audit table: log every rebalance move
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_rebalance_log (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id             UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  from_tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  to_tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  membership_id         UUID NOT NULL REFERENCES tenant_memberships(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason                TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rebalance_branch ON tenant_rebalance_log (branch_id);
CREATE INDEX IF NOT EXISTS idx_rebalance_from   ON tenant_rebalance_log (from_tenant_id);
CREATE INDEX IF NOT EXISTS idx_rebalance_to     ON tenant_rebalance_log (to_tenant_id);