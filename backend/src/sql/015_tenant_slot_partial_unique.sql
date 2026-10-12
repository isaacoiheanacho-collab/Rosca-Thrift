-- =============================================================================
-- 015_tenant_slot_partial_unique.sql
-- Convert uq_tenant_slot from a full unique constraint to a partial unique
-- index. This allows a REMOVED membership and a new ACTIVE membership to
-- both reference the same slot number within a tenant.
--
-- Background:
--   Tenure renewal marks declining members' memberships as status='REMOVED'.
--   Their slot must be reusable by the replacement. The original constraint
--   (tenant_id, slot_number) blocked this — it didn't care about status.
--
--   The new partial index enforces "one active membership per slot" which is
--   the actual invariant we want.
-- =============================================================================

-- Drop the old constraint
ALTER TABLE tenant_memberships
  DROP CONSTRAINT IF EXISTS uq_tenant_slot;

-- Replace with a partial unique index: unique among non-REMOVED rows only.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_slot_active
  ON tenant_memberships (tenant_id, slot_number)
  WHERE status != 'REMOVED';