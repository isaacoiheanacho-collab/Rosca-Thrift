-- =============================================================================
-- 013_cycle_advancement.sql
-- Adds a "cycle advancement" audit column to tenants.
--
-- The `cycle_advanced_at` column lets us know the last time the tenant's
-- cycle was bumped. Combined with row-level locking (SELECT FOR UPDATE),
-- this makes advancement idempotent.
-- =============================================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS cycle_advanced_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tenants_active_cycle_ends
  ON tenants (cycle_ends_at)
  WHERE status = 'ACTIVE';