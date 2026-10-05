-- =============================================================================
-- 005_branches_and_roles.sql
-- Introduce Branch model + split ADMIN into SUPER_ADMIN / BRANCH_ADMIN.
--
-- What this does:
--   - Wipes all existing test data (users, tokens, OTPs, KYC)
--   - Creates branches table
--   - Updates users.role to include SUPER_ADMIN, BRANCH_ADMIN, SAVER
--   - Adds users.branch_id (NULL for SUPER_ADMIN)
--   - Adds branch_id to kyc_submissions (if it exists)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Wipe test data. No real users exist yet.
-- ---------------------------------------------------------------------------
TRUNCATE TABLE refresh_tokens CASCADE;
TRUNCATE TABLE otp_codes CASCADE;
DROP TABLE IF EXISTS kyc_submissions CASCADE;
TRUNCATE TABLE users CASCADE;

-- ---------------------------------------------------------------------------
-- Branches
-- ---------------------------------------------------------------------------
CREATE TABLE branches (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Public identifier used in signup links: /join/<slug>
  slug                   TEXT NOT NULL UNIQUE,

  -- Display name (Branch Admin can rename)
  name                   TEXT NOT NULL,

  -- Status
  status                 TEXT NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED')),

  -- Trust account details (filled by Branch Admin after creation)
  trust_account_name     TEXT,
  trust_account_sort     TEXT,
  trust_account_number   TEXT,
  trust_account_holder   TEXT,

  -- Contact (filled by Super Admin at creation)
  contact_email          TEXT,
  contact_phone          TEXT,

  -- Audit
  created_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT branches_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$')
);

CREATE INDEX idx_branches_status ON branches (status);
CREATE INDEX idx_branches_slug   ON branches (slug);

DROP TRIGGER IF EXISTS trg_branches_updated_at ON branches;
CREATE TRIGGER trg_branches_updated_at
  BEFORE UPDATE ON branches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Recreate users table with new roles + branch_id
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS users CASCADE;

CREATE TABLE users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone              TEXT NOT NULL UNIQUE,
  email              TEXT UNIQUE,
  password_hash      TEXT NOT NULL,
  full_name          TEXT NOT NULL,

  role               TEXT NOT NULL DEFAULT 'SAVER'
                     CHECK (role IN ('SUPER_ADMIN', 'BRANCH_ADMIN', 'SAVER')),

  branch_id          UUID REFERENCES branches(id) ON DELETE RESTRICT,

  status             TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'VERIFIED', 'SUSPENDED')),

  phone_verified_at  TIMESTAMPTZ,
  email_verified_at  TIMESTAMPTZ,
  kyc_verified_at    TIMESTAMPTZ,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT users_phone_e164 CHECK (phone ~ '^\+[1-9]\d{6,14}$'),
  -- SUPER_ADMIN must have no branch; BRANCH_ADMIN and SAVER must have one
  CONSTRAINT users_branch_required CHECK (
    (role = 'SUPER_ADMIN' AND branch_id IS NULL)
    OR (role IN ('BRANCH_ADMIN', 'SAVER') AND branch_id IS NOT NULL)
  )
);

CREATE INDEX idx_users_phone     ON users (phone);
CREATE INDEX idx_users_email     ON users (LOWER(email)) WHERE email IS NOT NULL;
CREATE INDEX idx_users_role      ON users (role);
CREATE INDEX idx_users_branch    ON users (branch_id);
CREATE INDEX idx_users_status    ON users (status);

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Recreate refresh_tokens (cascade dropped it)
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS refresh_tokens CASCADE;

CREATE TABLE refresh_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  replaced_by     UUID REFERENCES refresh_tokens(id),
  user_agent      TEXT,
  ip_address      INET,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user_id    ON refresh_tokens (user_id);
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens (expires_at);
CREATE INDEX idx_refresh_tokens_active
  ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Recreate kyc_submissions with branch_id
-- ---------------------------------------------------------------------------
CREATE TABLE kyc_submissions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id         UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,

  legal_name        TEXT NOT NULL,
  selfie_object_key TEXT NOT NULL,

  bank_name         TEXT NOT NULL,
  account_number    TEXT NOT NULL,
  sort_code         TEXT NOT NULL,

  status            TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  reviewed_by       UUID REFERENCES users(id),
  reviewed_at       TIMESTAMPTZ,
  rejection_reason  TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_kyc_one_pending_per_user
  ON kyc_submissions (user_id) WHERE status = 'PENDING';
CREATE INDEX idx_kyc_status     ON kyc_submissions (status);
CREATE INDEX idx_kyc_user       ON kyc_submissions (user_id);
CREATE INDEX idx_kyc_branch     ON kyc_submissions (branch_id);
CREATE INDEX idx_kyc_created    ON kyc_submissions (created_at DESC);

DROP TRIGGER IF EXISTS trg_kyc_updated_at ON kyc_submissions;
CREATE TRIGGER trg_kyc_updated_at
  BEFORE UPDATE ON kyc_submissions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();