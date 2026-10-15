-- =============================================================================
-- 020_user_consents.sql
-- Records a user's acceptance (and eventual withdrawal) of legal documents:
--   TERMS         - Terms of Service
--   PRIVACY       - Privacy Policy
--   BRANCH_TERMS  - Branch-specific membership rules
--
-- Design:
--   - Append-only. We never UPDATE. Each consent event inserts a new row.
--   - `withdrawn_at IS NULL` means the consent is currently active.
--   - Consent is versioned. When a document changes materially, the version
--     bumps and the user must re-consent on next login (enforced in the API).
--
-- Withdrawal is locked while a user is inside an active tenure (see
-- consent.service.ts). This prevents a member walking away mid-cycle after
-- receiving a payout.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_consents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- 'TERMS' | 'PRIVACY' | 'BRANCH_TERMS'
  consent_type      TEXT NOT NULL
                    CHECK (consent_type IN ('TERMS', 'PRIVACY', 'BRANCH_TERMS')),

  -- '1.0.0', '1.0.1', etc.
  document_version  TEXT NOT NULL,

  -- Machine-friendly slug identifying the exact document.
  -- 'terms' | 'privacy' | 'branch-terms:dunamis-hq'
  document_slug     TEXT NOT NULL,

  accepted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  withdrawn_at      TIMESTAMPTZ,
  withdrawal_reason TEXT,  -- 'user_requested' | 'admin_forced' | 'document_updated'

  -- Audit
  ip_address        INET,
  user_agent        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup: does this user have an active consent for a given type?
CREATE INDEX IF NOT EXISTS idx_user_consents_active
  ON user_consents (user_id, consent_type)
  WHERE withdrawn_at IS NULL;

-- History view: everything for a user, newest first
CREATE INDEX IF NOT EXISTS idx_user_consents_history
  ON user_consents (user_id, created_at DESC);

-- Reporting: which users accepted a given version of a document
CREATE INDEX IF NOT EXISTS idx_user_consents_version
  ON user_consents (consent_type, document_version);

-- Prevent UPDATE (append-only); allow DELETE only via CASCADE
CREATE OR REPLACE FUNCTION prevent_user_consents_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'user_consents is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_consents_no_update ON user_consents;
CREATE TRIGGER trg_user_consents_no_update
  BEFORE UPDATE ON user_consents
  FOR EACH ROW EXECUTE FUNCTION prevent_user_consents_mutation();