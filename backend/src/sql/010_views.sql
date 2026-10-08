-- =============================================================================
-- 010_views.sql
-- Read-only views that flatten contributions, payouts, intents, and receipts
-- with human-readable joins. Used by admins for reference lookup in the
-- Neon dashboard UI (search/filter by reference, no SQL needed).
--
-- Views are read-only. No triggers, no writes.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Full contribution record — join to branch, saver, tenant, confirmer.
-- Search in Neon by: reference = 'INfdae97040103'
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_contributions_full AS
SELECT
  c.id                       AS contribution_id,
  c.reference                AS reference,

  -- Cycle context
  c.tenure                   AS tenure,
  c.cycle                    AS cycle,
  c.slot_number              AS slot_number,

  -- Money
  c.amount                   AS amount_pence,
  (c.amount / 100.0)         AS amount_gbp,
  c.currency                 AS currency,

  -- Who contributed
  c.user_id                  AS saver_user_id,
  u.full_name                AS saver_name,
  u.phone                    AS saver_phone,
  u.email                    AS saver_email,

  -- Which tenant
  c.tenant_id                AS tenant_id,
  t.name                     AS tenant_name,
  t.status                   AS tenant_status,

  -- Which branch
  c.branch_id                AS branch_id,
  b.name                     AS branch_name,
  b.slug                     AS branch_slug,

  -- Verification audit
  c.confirmed_by             AS confirmed_by_user_id,
  cu.full_name               AS confirmed_by_name,
  c.confirmed_at             AS confirmed_at,
  c.admin_note               AS admin_note,

  -- Source intent
  c.intent_id                AS intent_id,
  i.deadline_at              AS intent_deadline_at,
  i.state                    AS intent_state,

  -- Receipt (one receipt per intent, if uploaded)
  r.id                       AS receipt_id,
  r.object_key               AS receipt_object_key,
  r.mime_type                AS receipt_mime_type,
  r.created_at               AS receipt_uploaded_at,

  c.created_at               AS created_at

FROM contributions c
  JOIN users u        ON u.id = c.user_id
  JOIN users cu       ON cu.id = c.confirmed_by
  JOIN tenants t      ON t.id = c.tenant_id
  JOIN branches b     ON b.id = c.branch_id
  JOIN contribution_intents i ON i.id = c.intent_id
  LEFT JOIN receipts r ON r.intent_id = i.id;

-- ---------------------------------------------------------------------------
-- Full contribution intent record — includes state (pending/confirmed/late).
-- Useful for admin to see who hasn't paid in the current cycle.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_intents_full AS
SELECT
  i.id                       AS intent_id,
  i.reference                AS reference,

  i.tenure                   AS tenure,
  i.cycle                    AS cycle,
  i.slot_number              AS slot_number,
  i.state                    AS state,

  i.expected_amount          AS expected_amount_pence,
  (i.expected_amount / 100.0) AS expected_amount_gbp,

  i.user_id                  AS saver_user_id,
  u.full_name                AS saver_name,
  u.phone                    AS saver_phone,

  i.tenant_id                AS tenant_id,
  t.name                     AS tenant_name,

  i.branch_id                AS branch_id,
  b.name                     AS branch_name,

  i.deadline_at              AS deadline_at,
  (i.deadline_at < NOW() AND i.state = 'PENDING') AS is_overdue,

  -- Contribution recorded against this intent (if any)
  c.id                       AS contribution_id,
  c.amount                   AS contribution_amount_pence,
  c.confirmed_at             AS confirmed_at,

  i.created_at               AS created_at

FROM contribution_intents i
  JOIN users u          ON u.id = i.user_id
  JOIN tenants t        ON t.id = i.tenant_id
  JOIN branches b       ON b.id = i.branch_id
  LEFT JOIN contributions c ON c.intent_id = i.id;

-- ---------------------------------------------------------------------------
-- Full receipt record — search by reference to find the receipt image.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_receipts_full AS
SELECT
  r.id                       AS receipt_id,
  r.purpose                  AS purpose,

  -- What this receipt links to
  r.intent_id                AS intent_id,
  r.contribution_id          AS contribution_id,
  r.payout_id                AS payout_id,

  -- Reference (from whichever link is set)
  COALESCE(i.reference, c.reference) AS reference,

  -- Who uploaded
  r.uploaded_by              AS uploaded_by_user_id,
  u.full_name                AS uploaded_by_name,
  u.phone                    AS uploaded_by_phone,

  -- Branch
  r.branch_id                AS branch_id,
  b.name                     AS branch_name,

  -- File details
  r.object_key               AS object_key,
  r.file_name                AS file_name,
  r.mime_type                AS mime_type,
  (r.size_bytes / 1024.0)    AS size_kb,

  -- What the saver/admin claimed
  r.claimed_amount           AS claimed_amount_pence,
  r.claimed_reference        AS claimed_reference,
  r.claimed_sender_name      AS claimed_sender_name,
  r.claimed_note             AS claimed_note,

  r.created_at               AS uploaded_at

FROM receipts r
  JOIN users u          ON u.id = r.uploaded_by
  JOIN branches b       ON b.id = r.branch_id
  LEFT JOIN contribution_intents i ON i.id = r.intent_id
  LEFT JOIN contributions c        ON c.id = r.contribution_id;

-- ---------------------------------------------------------------------------
-- Full ledger record — every credit and debit, flattened.
-- Search by: reference = 'INfdae97040103'
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_ledger_full AS
SELECT
  l.id                       AS ledger_entry_id,
  l.reference                AS reference,
  l.account_type             AS account_type,
  l.entry_type               AS entry_type,
  l.entry_kind               AS entry_kind,

  l.amount                   AS amount_pence,
  (l.amount / 100.0)         AS amount_gbp,
  l.currency                 AS currency,

  CASE
    WHEN l.entry_type = 'CREDIT' THEN (l.amount / 100.0)
    ELSE -(l.amount / 100.0)
  END                        AS signed_amount_gbp,

  l.tenant_id                AS tenant_id,
  t.name                     AS tenant_name,

  l.branch_id                AS branch_id,
  b.name                     AS branch_name,

  l.contribution_id          AS contribution_id,
  l.payout_id                AS payout_id,

  l.description              AS description,

  l.created_by               AS created_by_user_id,
  cu.full_name               AS created_by_name,

  l.created_at               AS created_at

FROM ledger_entries l
  LEFT JOIN tenants t  ON t.id = l.tenant_id
  LEFT JOIN branches b ON b.id = l.branch_id
  LEFT JOIN users cu   ON cu.id = l.created_by;