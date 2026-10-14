-- =============================================================================
-- 017_payout_failures.sql
-- Failed payout handling: mark a payout as FAILED, retry with a new intent.
--
-- Adds:
--   - 'FAILED' to payout_intents.state enum
--   - Failure tracking columns on payout_intents
--   - payout_failures audit table (full history)
--   - retry_of_payout_id self-FK on payout_intents
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extend the payout_intents state check constraint to include FAILED.
-- ---------------------------------------------------------------------------
ALTER TABLE payout_intents
  DROP CONSTRAINT IF EXISTS payout_intents_state_check;

ALTER TABLE payout_intents
  ADD CONSTRAINT payout_intents_state_check
  CHECK (state IN ('PENDING', 'FEE_PAID', 'RECEIPT_UPLOADED', 'CONFIRMED', 'FAILED'));

-- ---------------------------------------------------------------------------
-- Failure tracking columns
-- ---------------------------------------------------------------------------
ALTER TABLE payout_intents
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;

ALTER TABLE payout_intents
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;

ALTER TABLE payout_intents
  ADD COLUMN IF NOT EXISTS failed_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE payout_intents
  ADD COLUMN IF NOT EXISTS retry_of_payout_id UUID REFERENCES payout_intents(id) ON DELETE SET NULL;

ALTER TABLE payout_intents
  ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_payout_intents_failed
  ON payout_intents (failed_at DESC)
  WHERE state = 'FAILED';

CREATE INDEX IF NOT EXISTS idx_payout_intents_retry_of
  ON payout_intents (retry_of_payout_id)
  WHERE retry_of_payout_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- payout_failures: full history of failures + retries.
-- Even if the original payout_intent is later retried and confirmed, this
-- table keeps the record of what went wrong and when.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payout_failures (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  payout_id         UUID NOT NULL REFERENCES payout_intents(id) ON DELETE CASCADE,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id         UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,

  reason            TEXT NOT NULL,
  marked_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  marked_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- If a retry was issued, this links to the new payout intent.
  retry_payout_id   UUID REFERENCES payout_intents(id) ON DELETE SET NULL,

  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payout_failures_payout
  ON payout_failures (payout_id, marked_at DESC);

CREATE INDEX IF NOT EXISTS idx_payout_failures_tenant
  ON payout_failures (tenant_id, marked_at DESC);

CREATE INDEX IF NOT EXISTS idx_payout_failures_branch
  ON payout_failures (branch_id, marked_at DESC);

CREATE INDEX IF NOT EXISTS idx_payout_failures_retry
  ON payout_failures (retry_payout_id)
  WHERE retry_payout_id IS NOT NULL;