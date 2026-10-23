-- =============================================================================
-- 021_branch_content.sql
-- Adds branch-owned content (About / Terms / Privacy) + onboarding fields.
--
-- Onboarding:
--   - A prospective branch admin fills the platform landing form.
--   - Branch is created with onboarding_status = 'PENDING'.
--   - Super admin approves or rejects.
--   - When APPROVED, the branch's /join/:slug page becomes live.
-- =============================================================================

ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS about_text TEXT,
  ADD COLUMN IF NOT EXISTS branch_terms TEXT,
  ADD COLUMN IF NOT EXISTS branch_privacy TEXT,
  ADD COLUMN IF NOT EXISTS branch_terms_version TEXT NOT NULL DEFAULT '1.0.0',
  ADD COLUMN IF NOT EXISTS branch_privacy_version TEXT NOT NULL DEFAULT '1.0.0',
  ADD COLUMN IF NOT EXISTS onboarding_status TEXT NOT NULL DEFAULT 'APPROVED'
    CHECK (onboarding_status IN ('PENDING', 'APPROVED', 'REJECTED')),
  ADD COLUMN IF NOT EXISTS onboarding_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS onboarding_note TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_rejection_reason TEXT;

-- Existing branches default to APPROVED so nothing breaks.
UPDATE branches SET onboarding_status = 'APPROVED' WHERE onboarding_status IS NULL;

CREATE INDEX IF NOT EXISTS idx_branches_onboarding_status
  ON branches (onboarding_status)
  WHERE onboarding_status != 'APPROVED';

-- Consent type: add BRANCH_PRIVACY alongside existing BRANCH_TERMS
-- (The 020 migration allowed BRANCH_TERMS. Add BRANCH_PRIVACY and PLATFORM_BUNDLE.)
ALTER TABLE user_consents
  DROP CONSTRAINT IF EXISTS user_consents_consent_type_check;

ALTER TABLE user_consents
  ADD CONSTRAINT user_consents_consent_type_check
  CHECK (consent_type IN ('TERMS', 'PRIVACY', 'BRANCH_TERMS', 'BRANCH_PRIVACY', 'PLATFORM_BUNDLE'));