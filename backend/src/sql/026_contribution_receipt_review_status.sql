-- Track contribution receipt review independently from contribution intent state.
ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS review_note TEXT;

ALTER TABLE receipts
  DROP CONSTRAINT IF EXISTS receipts_review_status_check;
ALTER TABLE receipts
  ADD CONSTRAINT receipts_review_status_check
  CHECK (review_status IN ('PENDING', 'REJECTED', 'APPROVED'));

-- Existing confirmed contributions have already passed receipt review.
UPDATE receipts r
SET review_status = 'APPROVED'
FROM contributions c
WHERE r.intent_id = c.intent_id
  AND r.purpose = 'CONTRIBUTION'
  AND r.review_status = 'PENDING';

-- Retain rejections recorded before this migration.
UPDATE receipts r
SET review_status = 'REJECTED',
    review_note = COALESCE(r.review_note, a.metadata->>'reason')
FROM audit_logs a
WHERE a.action = 'CONTRIBUTION_REJECTED'
  AND a.entity_type = 'contribution_intent'
  AND a.entity_id = r.intent_id::text
  AND r.purpose = 'CONTRIBUTION'
  AND r.review_status = 'PENDING'
  AND NOT EXISTS (SELECT 1 FROM contributions c WHERE c.intent_id = r.intent_id);

CREATE INDEX IF NOT EXISTS idx_receipts_pending_contribution_intent
  ON receipts (intent_id)
  WHERE purpose = 'CONTRIBUTION' AND review_status = 'PENDING';
