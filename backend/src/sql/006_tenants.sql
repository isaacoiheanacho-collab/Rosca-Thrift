-- =============================================================================
-- 006_tenants.sql
-- Tenants (12-member circles) + tenant_memberships (slot assignments).
--
-- A tenant belongs to a branch. Slots are 1-12. A tenant activates when full.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,

  -- Optional display name (auto-generated if not set)
  name            TEXT,

  status          TEXT NOT NULL DEFAULT 'FILLING'
                  CHECK (status IN ('FILLING', 'ACTIVE', 'COMPLETED', 'ARCHIVED')),

  current_cycle   INT NOT NULL DEFAULT 0
                  CHECK (current_cycle >= 0 AND current_cycle <= 12),

  activated_at    TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenants_branch        ON tenants (branch_id);
CREATE INDEX IF NOT EXISTS idx_tenants_status        ON tenants (status);
CREATE INDEX IF NOT EXISTS idx_tenants_branch_status ON tenants (branch_id, status);

DROP TRIGGER IF EXISTS trg_tenants_updated_at ON tenants;
CREATE TRIGGER trg_tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Tenant memberships — one row per member, one slot per tenant
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_memberships (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  slot_number     INT NOT NULL CHECK (slot_number BETWEEN 1 AND 12),

  status          TEXT NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE', 'COLLECTED', 'REMOVED')),

  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  collected_at    TIMESTAMPTZ,

  -- One user per tenant
  CONSTRAINT uq_tenant_user UNIQUE (tenant_id, user_id),
  -- One slot per tenant
  CONSTRAINT uq_tenant_slot UNIQUE (tenant_id, slot_number)
);

CREATE INDEX IF NOT EXISTS idx_memberships_tenant       ON tenant_memberships (tenant_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user         ON tenant_memberships (user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_tenant_slot  ON tenant_memberships (tenant_id, slot_number);
CREATE INDEX IF NOT EXISTS idx_memberships_status       ON tenant_memberships (status);