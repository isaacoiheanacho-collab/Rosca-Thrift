-- 003: Enforce dynamic business invariants at the database boundary.

CREATE FUNCTION enforce_tenant_configuration_capacity()
RETURNS TRIGGER AS $$
DECLARE configured_capacity INTEGER;
BEGIN
  SELECT max_co_savers INTO configured_capacity
  FROM circle_configurations
  WHERE id = NEW.configuration_id AND branch_id = NEW.branch_id;
  IF configured_capacity IS NULL THEN
    RAISE EXCEPTION 'Tenant configuration does not belong to its branch';
  END IF;
  IF NEW.capacity <> configured_capacity THEN
    RAISE EXCEPTION 'Tenant capacity must match its selected circle configuration';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenant_configuration_capacity_guard
BEFORE INSERT OR UPDATE OF configuration_id, branch_id, capacity ON tenants
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_configuration_capacity();

CREATE FUNCTION enforce_tenant_member_position()
RETURNS TRIGGER AS $$
DECLARE tenant_capacity INTEGER;
BEGIN
  SELECT capacity INTO tenant_capacity FROM tenants WHERE id = NEW.tenant_id;
  IF tenant_capacity IS NULL OR NEW.position > tenant_capacity THEN
    RAISE EXCEPTION 'Member position exceeds the tenant configured capacity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenant_member_position_guard
BEFORE INSERT OR UPDATE OF tenant_id, position ON tenant_members
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_member_position();

CREATE FUNCTION enforce_tenant_activation_and_completion()
RETURNS TRIGGER AS $$
DECLARE
  occupied_count INTEGER;
  verified_count INTEGER;
  paid_count INTEGER;
BEGIN
  IF NEW.status = 'active' AND OLD.status IS DISTINCT FROM 'active' THEN
    SELECT
      COUNT(*) FILTER (WHERE tm.registration_status = 'registered')::INTEGER,
      COUNT(*) FILTER (
        WHERE tm.registration_status = 'registered'
          AND tm.onboarding_status = 'approved'
          AND tm.verification_status = 'approved'
          AND u.phone_verified_at IS NOT NULL
      )::INTEGER
    INTO occupied_count, verified_count
    FROM tenant_members tm
    JOIN users u ON u.id = tm.user_id
    WHERE tm.tenant_id = NEW.id;

    IF occupied_count <> NEW.capacity OR verified_count <> NEW.capacity THEN
      RAISE EXCEPTION 'Tenant cannot activate until every configured position is occupied and verified';
    END IF;
  END IF;

  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    SELECT COUNT(*)::INTEGER INTO paid_count
    FROM payout_intents WHERE tenant_id = NEW.id AND status = 'paid';
    IF paid_count <> NEW.capacity THEN
      RAISE EXCEPTION 'Tenant cannot complete before every configured payout position is paid';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenant_lifecycle_guard
BEFORE UPDATE OF status ON tenants
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_activation_and_completion();

CREATE FUNCTION enforce_contribution_configuration_amount()
RETURNS TRIGGER AS $$
DECLARE configured_amount BIGINT;
BEGIN
  SELECT c.contribution_amount_pence INTO configured_amount
  FROM tenants t
  JOIN circle_configurations c ON c.id = t.configuration_id
  WHERE t.id = NEW.tenant_id;
  IF configured_amount IS NULL OR NEW.amount_pence <> configured_amount THEN
    RAISE EXCEPTION 'Contribution amount must match the tenant circle configuration';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER contribution_configuration_amount_guard
BEFORE INSERT OR UPDATE OF tenant_id, amount_pence ON contributions
FOR EACH ROW EXECUTE FUNCTION enforce_contribution_configuration_amount();

CREATE FUNCTION enforce_contribution_period_bounds()
RETURNS TRIGGER AS $$
DECLARE
  tenant_status TEXT;
  configured_duration INTEGER;
BEGIN
  SELECT t.status, c.duration_periods INTO tenant_status, configured_duration
  FROM tenants t
  JOIN circle_configurations c ON c.id = t.configuration_id
  WHERE t.id = NEW.tenant_id;
  IF tenant_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Contribution periods can only be created for an active tenant';
  END IF;
  IF NEW.period_number > configured_duration THEN
    RAISE EXCEPTION 'Contribution period exceeds the configured duration';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER contribution_period_bounds_guard
BEFORE INSERT OR UPDATE OF tenant_id, period_number ON contribution_periods
FOR EACH ROW EXECUTE FUNCTION enforce_contribution_period_bounds();

CREATE FUNCTION enforce_payout_configuration_math()
RETURNS TRIGGER AS $$
DECLARE
  configured_amount BIGINT;
  configured_capacity INTEGER;
  configured_positions INTEGER;
  expected_tvc BIGINT;
  expected_fee BIGINT;
  member_position INTEGER;
BEGIN
  SELECT c.contribution_amount_pence, t.capacity, c.collection_positions
  INTO configured_amount, configured_capacity, configured_positions
  FROM tenants t
  JOIN circle_configurations c ON c.id = t.configuration_id
  WHERE t.id = NEW.tenant_id;

  SELECT position INTO member_position
  FROM tenant_members
  WHERE id = NEW.recipient_member_id AND tenant_id = NEW.tenant_id;

  IF configured_amount IS NULL OR member_position IS NULL THEN
    RAISE EXCEPTION 'Payout tenant or recipient member is invalid';
  END IF;
  IF NEW.collection_position > configured_positions OR member_position <> NEW.collection_position THEN
    RAISE EXCEPTION 'Payout recipient must occupy the configured collection position';
  END IF;
  IF NEW.gross_pool_pence <> configured_amount * configured_capacity THEN
    RAISE EXCEPTION 'Gross payout pool must equal configured contribution multiplied by configured capacity';
  END IF;

  IF configured_capacity = 1 THEN
    expected_tvc := 0;
  ELSE
    expected_tvc := ROUND(
      configured_amount::NUMERIC
      * (2 * NEW.collection_position - configured_capacity - 1)::NUMERIC
      / (2 * (configured_capacity - 1))
    )::BIGINT;
  END IF;
  IF NEW.tvc_adjustment_pence <> expected_tvc
     OR ABS(NEW.tvc_adjustment_pence) * 2 > configured_amount THEN
    RAISE EXCEPTION 'TVC adjustment does not match the configured position-based calculation';
  END IF;

  IF NEW.platform_fee_bps <> 50 THEN
    RAISE EXCEPTION 'Platform maintenance fee must be 0.5 percent (50 basis points)';
  END IF;
  expected_fee := ROUND(NEW.amount_after_tvc_pence::NUMERIC * 50 / 10000)::BIGINT;
  IF NEW.platform_fee_pence <> expected_fee THEN
    RAISE EXCEPTION 'Platform fee does not match 0.5 percent of the amount after TVC';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payout_configuration_math_guard
BEFORE INSERT OR UPDATE OF tenant_id, collection_position, recipient_member_id,
  gross_pool_pence, tvc_adjustment_pence, amount_after_tvc_pence,
  platform_fee_bps, platform_fee_pence ON payout_intents
FOR EACH ROW EXECUTE FUNCTION enforce_payout_configuration_math();
