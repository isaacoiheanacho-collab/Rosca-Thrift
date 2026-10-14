-- =============================================================================
-- 018_payout_retry_support.sql
-- Allow multiple payout_intents per (tenant, tenure, cycle) when they are
-- failed/retried. The uniqueness that matters is:
--
--   "one NON-FAILED payout intent per (tenant, tenure, cycle)"
--
-- A failed intent may be succeeded by a retry. The retry creates a new row
-- with retry_of_payout_id pointing to the original. Only the active attempt
-- (PENDING / FEE_PAID / RECEIPT_UPLOADED / CONFIRMED) is unique.
-- =============================================================================

-- Drop the full unique constraint on payout_intents
ALTER TABLE payout_intents
  DROP CONSTRAINT IF EXISTS uq_payout_intent_tenant_tenure_cycle;

-- Replace with a partial unique index — only enforce on non-FAILED rows
CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_intent_active
  ON payout_intents (tenant_id, tenure, cycle)
  WHERE state != 'FAILED';

-- Same story for platform_fee_intents: allow multiple fee intents per cycle
-- if one was rejected and re-issued. But we currently reuse the fee intent
-- on retry (no new fee intent is created), so the existing constraint is
-- still correct. Leave it as-is.