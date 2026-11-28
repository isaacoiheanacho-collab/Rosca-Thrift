-- 005: Configurable platform maintenance fee policy.
-- Existing circle configurations retain 0.5%; new configurations inherit 1%.

ALTER TABLE circle_configurations
  ADD COLUMN maintenance_fee_bps INTEGER NOT NULL DEFAULT 50
  CHECK (maintenance_fee_bps BETWEEN 0 AND 10000);

-- The column default for future configurations is not the policy source.
-- The application will explicitly snapshot the current policy when creating a circle.

CREATE TABLE platform_maintenance_fee_policy (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  maintenance_fee_bps INTEGER NOT NULL
    CHECK (maintenance_fee_bps BETWEEN 0 AND 10000),
  updated_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO platform_maintenance_fee_policy (id, maintenance_fee_bps)
VALUES (1, 100);

CREATE TABLE platform_maintenance_fee_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  previous_fee_bps INTEGER,
  new_fee_bps INTEGER NOT NULL CHECK (new_fee_bps BETWEEN 0 AND 10000),
  changed_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO platform_maintenance_fee_history
  (previous_fee_bps, new_fee_bps, reason)
VALUES
  (NULL, 100, 'Initial platform maintenance fee policy');

-- Lock the fee rate alongside all other circle configuration terms.
CREATE OR REPLACE FUNCTION prevent_circle_configuration_terms_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.contribution_amount_pence IS DISTINCT FROM OLD.contribution_amount_pence
     OR NEW.frequency IS DISTINCT FROM OLD.frequency
     OR NEW.max_co_savers IS DISTINCT FROM OLD.max_co_savers
     OR NEW.collection_positions IS DISTINCT FROM OLD.collection_positions
     OR NEW.duration_periods IS DISTINCT FROM OLD.duration_periods
     OR NEW.maintenance_fee_bps IS DISTINCT FROM OLD.maintenance_fee_bps
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
    RAISE EXCEPTION 'Circle configuration terms are immutable; create a new configuration';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Enforce that every payout uses the rate snapshotted by its circle.
CREATE OR REPLACE FUNCTION enforce_payout_configuration_math()
RETURNS TRIGGER AS $$
DECLARE
  configured_amount BIGINT;
  configured_capacity INTEGER;
  configured_positions INTEGER;
  configured_fee_bps INTEGER;
  expected_tvc BIGINT;
  expected_fee BIGINT;
  member_position INTEGER;
BEGIN
  SELECT c.contribution_amount_pence, t.capacity,
         c.collection_positions, c.maintenance_fee_bps
  INTO configured_amount, configured_capacity,
       configured_positions, configured_fee_bps
  FROM tenants t
  JOIN circle_configurations c ON c.id = t.configuration_id
  WHERE t.id = NEW.tenant_id;

  SELECT position INTO member_position
  FROM tenant_members
  WHERE id = NEW.recipient_member_id AND tenant_id = NEW.tenant_id;

  IF configured_amount IS NULL OR member_position IS NULL THEN
    RAISE EXCEPTION 'Payout tenant or recipient member is invalid';
  END IF;

  IF NEW.collection_position > configured_positions
     OR member_position <> NEW.collection_position THEN
    RAISE EXCEPTION 'Payout recipient must occupy the configured collection position';
  END IF;

  IF NEW.gross_pool_pence <> configured_amount * configured_capacity THEN
    RAISE EXCEPTION 'Gross payout pool must equal configured contribution multiplied by configured capacity';
  END IF;

  IF configured_capacity = 1 THEN
    expected_tvc := 0;
  ELSE
    expected_tvc := GREATEST(
      -FLOOR(configured_amount::NUMERIC / 2)::BIGINT,
      LEAST(
        ROUND(
          configured_amount::NUMERIC
          * (2 * NEW.collection_position - configured_capacity - 1)::NUMERIC
          / (2 * (configured_capacity - 1))
        )::BIGINT,
        FLOOR(configured_amount::NUMERIC / 2)::BIGINT
      )
    );
  END IF;

  IF NEW.tvc_adjustment_pence <> expected_tvc
     OR ABS(NEW.tvc_adjustment_pence) * 2 > configured_amount THEN
    RAISE EXCEPTION 'TVC adjustment does not match the configured position-based calculation';
  END IF;

  IF NEW.platform_fee_bps <> configured_fee_bps THEN
    RAISE EXCEPTION 'Payout maintenance fee rate must match its circle configuration';
  END IF;

  expected_fee := ROUND(
    NEW.amount_after_tvc_pence::NUMERIC * configured_fee_bps / 10000
  )::BIGINT;

  IF NEW.platform_fee_pence <> expected_fee THEN
    RAISE EXCEPTION 'Platform fee does not match the configured rate applied after TVC';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
