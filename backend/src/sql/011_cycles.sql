-- =============================================================================
-- 011_cycles.sql
-- Add cycle tracking columns to tenants.
-- =============================================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS current_tenure INT NOT NULL DEFAULT 1
  CHECK (current_tenure >= 1);

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS cycle_started_at TIMESTAMPTZ;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS cycle_ends_at TIMESTAMPTZ;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS cycle_contribution_deadline_at TIMESTAMPTZ;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS cycle_payout_at TIMESTAMPTZ;

-- Backfill existing ACTIVE tenants (test data)
UPDATE tenants
SET
  cycle_started_at = NOW(),
  cycle_ends_at = NOW() + INTERVAL '30 days',
  cycle_contribution_deadline_at = NOW() + INTERVAL '21 days',
  cycle_payout_at = NOW() + INTERVAL '30 days'
WHERE status = 'ACTIVE'
  AND cycle_started_at IS NULL;

-- Sanity constraint
ALTER TABLE tenants
  ADD CONSTRAINT tenants_active_has_cycle
  CHECK (
    status IN ('FILLING', 'ARCHIVED')
    OR (cycle_started_at IS NOT NULL AND cycle_ends_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_tenants_cycle_deadline ON tenants (cycle_contribution_deadline_at)
  WHERE status = 'ACTIVE';