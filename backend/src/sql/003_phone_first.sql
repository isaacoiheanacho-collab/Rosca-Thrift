-- =============================================================================
-- 003_phone_first.sql
-- Phone-first authentication.
--
-- Changes:
--   - users: phone becomes required, adds phone_verified_at, email becomes optional
--   - new table: otp_codes (SMS one-time codes for signup / reset / verify)
--   - truncates existing test users (no real users exist yet)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Clean slate: truncate existing test users and their dependent data.
-- No real users exist yet - safe at this stage.
-- ---------------------------------------------------------------------------
TRUNCATE TABLE refresh_tokens CASCADE;
TRUNCATE TABLE users CASCADE;

-- ---------------------------------------------------------------------------
-- Users: phone required, email optional, track verification timestamps.
-- Drop and recreate because the constraint changes are non-trivial.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS users CASCADE;

CREATE TABLE users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone              TEXT NOT NULL UNIQUE,
  email              TEXT UNIQUE,
  password_hash      TEXT NOT NULL,
  full_name          TEXT NOT NULL,
  role               TEXT NOT NULL DEFAULT 'SAVER'
                     CHECK (role IN ('SAVER', 'ADMIN')),
  status             TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'VERIFIED', 'SUSPENDED')),

  phone_verified_at  TIMESTAMPTZ,
  email_verified_at  TIMESTAMPTZ,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT users_phone_e164 CHECK (phone ~ '^\+[1-9]\d{6,14}$')
);

CREATE INDEX idx_users_phone  ON users (phone);
CREATE INDEX idx_users_email  ON users (LOWER(email)) WHERE email IS NOT NULL;
CREATE INDEX idx_users_role   ON users (role);
CREATE INDEX idx_users_status ON users (status);

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Recreate refresh_tokens (it referenced the old users table).
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
-- OTP codes: hashed, single-use, time-limited, attempt-limited.
-- ---------------------------------------------------------------------------
CREATE TABLE otp_codes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  purpose      TEXT NOT NULL
               CHECK (purpose IN ('signup', 'reset', 'verify_phone')),
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  attempts     INT NOT NULL DEFAULT 0,
  ip_address   INET,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_otp_phone_purpose_active
  ON otp_codes (phone, purpose) WHERE consumed_at IS NULL;
CREATE INDEX idx_otp_expires ON otp_codes (expires_at);
CREATE INDEX idx_otp_phone_recent ON otp_codes (phone, created_at DESC);