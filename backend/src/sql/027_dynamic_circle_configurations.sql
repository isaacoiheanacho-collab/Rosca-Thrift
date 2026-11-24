-- =============================================================================
-- 027_dynamic_circle_configurations.sql
-- Dynamic, reusable circle configurations with independent tenant sequences.
--
-- Existing tenants are attached to one legacy 12-member configuration per
-- branch. Their membership, cycle and payout history is not rewritten.
-- =============================================================================

CREATE TABLE IF NOT EXISTS circle_configurations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id                UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  name                     TEXT NOT NULL,
  contribution_amount      BIGINT NOT NULL CHECK (contribution_amount > 0),
  contribution_frequency   TEXT NOT NULL CHECK (contribution_frequency IN ('WEEKLY', 'MONTHLY')),
  member_capacity          INT NOT NULL CHECK (member_capacity BETWEEN 2 AND 100),
  collection_positions     INT NOT NULL,
  contribution_window_days INT NOT NULL,
  cycle_duration_days      INT NOT NULL,
  is_legacy                BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by               UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT circle_config_positions_match_capacity
    CHECK (collection_positions = member_capacity),
  CONSTRAINT circle_config_schedule_valid
    CHECK (contribution_window_days > 0 AND cycle_duration_days >= contribution_window_days),
  CONSTRAINT uq_circle_config_name_per_branch UNIQUE (branch_id, name)
);

CREATE INDEX IF NOT EXISTS idx_circle_configurations_branch
  ON circle_configurations (branch_id, created_at);

-- A tenant is one generated circle in a reusable configuration stream.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS configuration_id UUID
    REFERENCES circle_configurations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS member_capacity_snapshot INT;

-- One legacy configuration per existing branch. Existing tenants retain their
-- exact membership and are associated with the legacy 12-member arrangement.
INSERT INTO circle_configurations (
  branch_id, name, contribution_amount, contribution_frequency,
  member_capacity, collection_positions,
  contribution_window_days, cycle_duration_days, is_legacy
)
SELECT
  b.id,
  'Legacy 12-member configuration',
  100000,
  'MONTHLY',
  12,
  12,
  21,
  30,
  TRUE
FROM branches b
WHERE EXISTS (SELECT 1 FROM tenants t WHERE t.branch_id = b.id)
  AND NOT EXISTS (
    SELECT 1 FROM circle_configurations c
    WHERE c.branch_id = b.id AND c.is_legacy = TRUE
  );

UPDATE tenants t
SET configuration_id = c.id,
    member_capacity_snapshot = 12
FROM circle_configurations c
WHERE c.branch_id = t.branch_id
  AND c.is_legacy = TRUE
  AND t.configuration_id IS NULL;

ALTER TABLE tenants
  ALTER COLUMN configuration_id SET NOT NULL,
  ALTER COLUMN member_capacity_snapshot SET NOT NULL;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_member_capacity_snapshot_valid
  CHECK (member_capacity_snapshot BETWEEN 2 AND 100);

-- Capacity is now tenant-specific. Drop the original fixed 1..12 slot check.
ALTER TABLE tenant_memberships
  DROP CONSTRAINT IF EXISTS tenant_memberships_slot_number_check;

ALTER TABLE tenant_memberships
  ADD CONSTRAINT tenant_memberships_slot_number_positive
  CHECK (slot_number >= 1);

-- Current cycle is bounded by the tenant's own collection positions, not 12.
ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_current_cycle_check;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_current_cycle_nonnegative
  CHECK (current_cycle >= 0);

-- Prevent identical material configurations under the same branch. The
-- configuration name is deliberately excluded: naming cannot bypass dedupe.
CREATE UNIQUE INDEX IF NOT EXISTS uq_circle_config_material_settings
  ON circle_configurations (
    branch_id,
    contribution_amount,
    contribution_frequency,
    member_capacity,
    contribution_window_days,
    cycle_duration_days
  )
  WHERE is_legacy = FALSE;

-- Each configuration has its own sequential tenant names.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_configuration_name
  ON tenants (configuration_id, name);
