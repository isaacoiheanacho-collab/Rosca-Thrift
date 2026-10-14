-- =============================================================================
-- 019_branch_branding.sql
-- Adds a JSONB branding column on branches for white-label support.
--
-- Branding fields (all optional, defaults to empty object):
--   {
--     "logoUrl": "https://...",
--     "primaryColor": "#00daf3",
--     "accentColor": "#4edea3",
--     "displayName": "Dunamis HQ",
--     "contactEmail": "hq@example.com"
--   }
--
-- The frontend reads this to re-theme per branch. Falls back to global
-- defaults when fields are missing.
-- =============================================================================

ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS branding JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Sanity check: it must be an object (not an array, string, etc.)
ALTER TABLE branches
  DROP CONSTRAINT IF EXISTS branches_branding_is_object;

ALTER TABLE branches
  ADD CONSTRAINT branches_branding_is_object
  CHECK (jsonb_typeof(branding) = 'object');