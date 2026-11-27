-- 004: In-app notification read tracking.
ALTER TABLE notifications ADD COLUMN read_at TIMESTAMPTZ;
CREATE INDEX notifications_user_unread_idx
  ON notifications(user_id, created_at DESC)
  WHERE read_at IS NULL AND status = 'sent';
