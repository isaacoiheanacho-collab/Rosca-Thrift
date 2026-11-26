-- =============================================================================
-- 028_dynamic_cycle_and_slot_capacity.sql
-- Remove historical 1..12 limits from cycle and slot records.
-- Circle configurations support capacities and collection positions up to 100.
-- Existing records are retained; this migration changes validation only.
-- =============================================================================

ALTER TABLE contribution_intents
  DROP CONSTRAINT IF EXISTS contribution_intents_cycle_check,
  DROP CONSTRAINT IF EXISTS contribution_intents_slot_number_check;

ALTER TABLE contribution_intents
  ADD CONSTRAINT contribution_intents_cycle_dynamic_check
    CHECK (cycle BETWEEN 1 AND 100),
  ADD CONSTRAINT contribution_intents_slot_number_dynamic_check
    CHECK (slot_number BETWEEN 1 AND 100);

ALTER TABLE contributions
  DROP CONSTRAINT IF EXISTS contributions_cycle_check,
  DROP CONSTRAINT IF EXISTS contributions_slot_number_check;

ALTER TABLE contributions
  ADD CONSTRAINT contributions_cycle_dynamic_check
    CHECK (cycle BETWEEN 1 AND 100),
  ADD CONSTRAINT contributions_slot_number_dynamic_check
    CHECK (slot_number BETWEEN 1 AND 100);

ALTER TABLE platform_fee_intents
  DROP CONSTRAINT IF EXISTS platform_fee_intents_cycle_check;

ALTER TABLE platform_fee_intents
  ADD CONSTRAINT platform_fee_intents_cycle_dynamic_check
    CHECK (cycle BETWEEN 1 AND 100);

ALTER TABLE payout_intents
  DROP CONSTRAINT IF EXISTS payout_intents_cycle_check,
  DROP CONSTRAINT IF EXISTS payout_intents_recipient_slot_check;

ALTER TABLE payout_intents
  ADD CONSTRAINT payout_intents_cycle_dynamic_check
    CHECK (cycle BETWEEN 1 AND 100),
  ADD CONSTRAINT payout_intents_recipient_slot_dynamic_check
    CHECK (recipient_slot BETWEEN 1 AND 100);

ALTER TABLE tenure_renewals
  DROP CONSTRAINT IF EXISTS tenure_renewals_slot_number_check;

ALTER TABLE tenure_renewals
  ADD CONSTRAINT tenure_renewals_slot_number_dynamic_check
    CHECK (slot_number BETWEEN 1 AND 100);
