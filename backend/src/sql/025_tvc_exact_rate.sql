-- Exact annual TVC rate snapshots. Historical active tenures and payouts
-- retain their existing basis-point rate; new tenures use the exact 1/11 rate.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS current_tenure_tvc_rate_numerator INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS current_tenure_tvc_rate_denominator INT NOT NULL DEFAULT 11;
UPDATE tenants
SET current_tenure_tvc_rate_numerator = current_tenure_tvc_bps,
    current_tenure_tvc_rate_denominator = 10000;
ALTER TABLE tenants
  ADD CONSTRAINT tenants_tvc_rate_numerator_positive CHECK (current_tenure_tvc_rate_numerator > 0),
  ADD CONSTRAINT tenants_tvc_rate_denominator_positive CHECK (current_tenure_tvc_rate_denominator > 0);

ALTER TABLE payout_intents
  ADD COLUMN IF NOT EXISTS tvc_rate_numerator INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS tvc_rate_denominator INT NOT NULL DEFAULT 11;
UPDATE payout_intents
SET tvc_rate_numerator = tvc_bps,
    tvc_rate_denominator = 10000;
ALTER TABLE payout_intents
  ADD CONSTRAINT payout_intents_tvc_rate_numerator_positive CHECK (tvc_rate_numerator > 0),
  ADD CONSTRAINT payout_intents_tvc_rate_denominator_positive CHECK (tvc_rate_denominator > 0);
