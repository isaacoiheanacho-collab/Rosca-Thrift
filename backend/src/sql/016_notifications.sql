-- =============================================================================
-- 016_notifications.sql
-- Notification feed (persistent history) + Web Push subscriptions.
--
-- Two tables:
--   notifications        - one row per event per user (the feed)
--   push_subscriptions   - browser push endpoints (one user → many devices)
--
-- Realtime is delivered via:
--   1. Socket.IO     (in-app live update, works while app is open)
--   2. Web Push      (browser-native, works even when app is closed)
--
-- The `notifications` row is the source of truth — even if push delivery
-- fails (permission denied, offline, etc.), the user sees the feed next open.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Notifications feed
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Optional scoping (nullable for user-level events like KYC approved)
  tenant_id       UUID REFERENCES tenants(id) ON DELETE SET NULL,
  branch_id       UUID REFERENCES branches(id) ON DELETE SET NULL,

  -- Event kind — matches the service helpers (see notifications.service.ts)
  kind            TEXT NOT NULL,

  -- Display content
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,

  -- Optional metadata (link to a payout, intent, receipt, etc.)
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Read tracking
  read_at         TIMESTAMPTZ,

  -- Delivery tracking (in-app is the source of truth; push is best-effort)
  pushed_at       TIMESTAMPTZ,          -- set when web push accepted by browser
  push_failed_at  TIMESTAMPTZ,          -- set when push delivery failed
  push_error      TEXT,                 -- last push error (for debugging)

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Feed query: newest first for one user, optionally filtered by read
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications (user_id, created_at DESC);

-- Unread badge count: cheap because most notifications are read
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;

-- Per-tenant browsing (e.g., admin sees all tenant events)
CREATE INDEX IF NOT EXISTS idx_notifications_tenant_created
  ON notifications (tenant_id, created_at DESC)
  WHERE tenant_id IS NOT NULL;

-- Event kind lookup (analytics, debugging)
CREATE INDEX IF NOT EXISTS idx_notifications_kind
  ON notifications (kind, created_at DESC);

-- ---------------------------------------------------------------------------
-- Web Push subscriptions
-- One user can have many subscriptions (phone + laptop + tablet, etc.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Push service endpoint (unique per browser/device)
  endpoint        TEXT NOT NULL UNIQUE,

  -- Encryption keys — required to sign the push payload
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,

  -- Optional device hint for the user to identify subscriptions
  user_agent      TEXT,

  -- Liveness
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_push_subs_user
  ON push_subscriptions (user_id)
  WHERE revoked_at IS NULL;

DROP TRIGGER IF EXISTS trg_push_subs_noop ON push_subscriptions;
-- No updated_at trigger — we only write last_used_at from the sender.