-- =============================================================================
-- 029_dynamic_collection_position_constraints.sql
-- Remove the remaining fixed 12-position database constraints.
-- Capacity is validated against each tenant's configured capacity snapshot.
-- =============================================================================

ALTER TABLE platform_fee_intents
  DROP CONSTRAINT IF EXISTS platform_fee_intents_cycle_check;
ALTER TABLE platform_fee_intents
  ADD CONSTRAINT platform_fee_intents_cycle_positive CHECK (cycle >= 1);

ALTER TABLE payout_intents
  DROP CONSTRAINT IF EXISTS payout_intents_cycle_check,
  DROP CONSTRAINT IF EXISTS payout_intents_recipient_slot_check;
ALTER TABLE payout_intents
  ADD CONSTRAINT payout_intents_cycle_positive CHECK (cycle >= 1),
  ADD CONSTRAINT payout_intents_recipient_slot_positive CHECK (recipient_slot >= 1);

ALTER TABLE tenure_renewals
  DROP CONSTRAINT IF EXISTS tenure_renewals_slot_number_check;
ALTER TABLE tenure_renewals
  ADD CONSTRAINT tenure_renewals_slot_number_positive CHECK (slot_number >= 1);

-- The database was reset before this migration. Remove empty-database legacy
-- 12-member seed configurations; circles must now be created from an explicitly
-- selected configuration created by the branch administrator.
DELETE FROM circle_configurations c
WHERE c.is_legacy = TRUE
  AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.configuration_id = c.id);

-- Enforce the configured capacity at the database boundary. This protects
-- inserts from every application path, not only the API validation layer.
CREATE OR REPLACE FUNCTION enforce_tenant_collection_position()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  configured_capacity INT;
  requested_cycle INT;
  requested_slot INT;
BEGIN
  SELECT member_capacity_snapshot
    INTO configured_capacity
    FROM tenants
   WHERE id = NEW.tenant_id
   FOR KEY SHARE;

  IF configured_capacity IS NULL THEN
    RAISE EXCEPTION 'Tenant % has no configured capacity', NEW.tenant_id
      USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'tenure_renewals' THEN
    requested_slot := NEW.slot_number;
    IF requested_slot < 1 OR requested_slot > configured_capacity THEN
      RAISE EXCEPTION 'Renewal slot % is outside tenant capacity 1-%',
        requested_slot, configured_capacity
        USING ERRCODE = '23514';
    END IF;
  ELSE
    requested_cycle := NEW.cycle;
    IF requested_cycle < 1 OR requested_cycle > configured_capacity THEN
      RAISE EXCEPTION 'Cycle % is outside tenant capacity 1-%',
        requested_cycle, configured_capacity
        USING ERRCODE = '23514';
    END IF;

    IF TG_TABLE_NAME = 'payout_intents' THEN
      requested_slot := NEW.recipient_slot;
      IF requested_slot < 1 OR requested_slot > configured_capacity
         OR requested_slot <> requested_cycle THEN
        RAISE EXCEPTION 'Recipient slot % must match cycle % and be within tenant capacity 1-%',
          requested_slot, requested_cycle, configured_capacity
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fee_intent_dynamic_cycle ON platform_fee_intents;
CREATE TRIGGER trg_fee_intent_dynamic_cycle
  BEFORE INSERT OR UPDATE ON platform_fee_intents
  FOR EACH ROW EXECUTE FUNCTION enforce_tenant_collection_position();

DROP TRIGGER IF EXISTS trg_payout_intent_dynamic_cycle ON payout_intents;
CREATE TRIGGER trg_payout_intent_dynamic_cycle
  BEFORE INSERT OR UPDATE ON payout_intents
  FOR EACH ROW EXECUTE FUNCTION enforce_tenant_collection_position();

DROP TRIGGER IF EXISTS trg_tenure_renewal_dynamic_slot ON tenure_renewals;
CREATE TRIGGER trg_tenure_renewal_dynamic_slot
  BEFORE INSERT OR UPDATE ON tenure_renewals
  FOR EACH ROW EXECUTE FUNCTION enforce_tenant_collection_position();
