-- 001: Dynamic ROSCA domain foundation.
-- Money is stored as integer pence. No global contribution or circle capacity exists.

CREATE TABLE branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  slug TEXT NOT NULL UNIQUE CHECK (slug = lower(slug)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL CHECK (length(btrim(full_name)) > 0),
  phone_e164 TEXT NOT NULL UNIQUE,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('MEMBER', 'BRANCH_ADMIN', 'SUPER_ADMIN')),
  phone_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE branch_admins (
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (branch_id, user_id)
);

CREATE TABLE circle_configurations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  contribution_amount_pence BIGINT NOT NULL CHECK (contribution_amount_pence > 0),
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly', 'monthly')),
  max_co_savers INTEGER NOT NULL CHECK (max_co_savers > 0),
  collection_positions INTEGER NOT NULL CHECK (collection_positions > 0),
  duration_periods INTEGER NOT NULL CHECK (duration_periods > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  public_join_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT circle_configuration_positions_match_capacity
    CHECK (collection_positions = max_co_savers),
  CONSTRAINT circle_configuration_duration_matches_positions
    CHECK (duration_periods = collection_positions),
  CONSTRAINT circle_configuration_id_branch_unique UNIQUE (id, branch_id)
);

-- Configuration identity and operating terms are immutable. Status and
-- public visibility may change without rewriting the terms used by tenants.
CREATE FUNCTION prevent_circle_configuration_terms_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.contribution_amount_pence IS DISTINCT FROM OLD.contribution_amount_pence
     OR NEW.frequency IS DISTINCT FROM OLD.frequency
     OR NEW.max_co_savers IS DISTINCT FROM OLD.max_co_savers
     OR NEW.collection_positions IS DISTINCT FROM OLD.collection_positions
     OR NEW.duration_periods IS DISTINCT FROM OLD.duration_periods
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
    RAISE EXCEPTION 'Circle configuration terms are immutable; create a new configuration';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER circle_configuration_terms_immutable
BEFORE UPDATE ON circle_configurations
FOR EACH ROW EXECUTE FUNCTION prevent_circle_configuration_terms_change();

CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL,
  configuration_id UUID NOT NULL,
  tenant_sequence INTEGER NOT NULL CHECK (tenant_sequence > 0),
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  status TEXT NOT NULL DEFAULT 'filling'
    CHECK (status IN ('filling', 'awaiting_verification', 'active', 'completed', 'suspended', 'cancelled')),
  activated_at TIMESTAMPTZ,
  schedule_start_at TIMESTAMPTZ,
  schedule_end_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenant_configuration_branch_fk
    FOREIGN KEY (configuration_id, branch_id)
    REFERENCES circle_configurations(id, branch_id) ON DELETE RESTRICT,
  CONSTRAINT tenant_sequence_per_configuration UNIQUE (configuration_id, tenant_sequence),
  CONSTRAINT tenant_id_configuration_unique UNIQUE (id, configuration_id),
  CONSTRAINT tenant_id_branch_unique UNIQUE (id, branch_id)
);

CREATE TABLE tenant_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position > 0),
  registration_status TEXT NOT NULL DEFAULT 'registered'
    CHECK (registration_status IN ('registered', 'withdrawn', 'rejected')),
  onboarding_status TEXT NOT NULL DEFAULT 'incomplete'
    CHECK (onboarding_status IN ('incomplete', 'submitted', 'approved', 'rejected')),
  verification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending', 'approved', 'rejected')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ,
  CONSTRAINT tenant_member_position_unique UNIQUE (tenant_id, position),
  CONSTRAINT tenant_member_user_unique UNIQUE (tenant_id, user_id),
  CONSTRAINT tenant_member_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE TABLE kyc_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  tenant_member_id UUID REFERENCES tenant_members(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'submitted', 'under_review', 'approved', 'rejected')),
  provider TEXT,
  provider_reference TEXT,
  submitted_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE contribution_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  period_number INTEGER NOT NULL CHECK (period_number > 0),
  period_start_at TIMESTAMPTZ NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  period_end_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'open', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT contribution_period_dates_valid CHECK (period_start_at <= due_at AND due_at <= period_end_at),
  CONSTRAINT contribution_period_number_unique UNIQUE (tenant_id, period_number),
  CONSTRAINT contribution_period_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE TABLE contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  period_id UUID NOT NULL,
  tenant_member_id UUID NOT NULL,
  amount_pence BIGINT NOT NULL CHECK (amount_pence > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'received', 'failed', 'reconciled')),
  payment_provider TEXT,
  payment_reference TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  received_at TIMESTAMPTZ,
  reconciled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (period_id, tenant_id)
    REFERENCES contribution_periods(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_member_id, tenant_id)
    REFERENCES tenant_members(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT contribution_member_period_unique UNIQUE (period_id, tenant_member_id)
);

CREATE TABLE payout_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  collection_position INTEGER NOT NULL CHECK (collection_position > 0),
  recipient_member_id UUID NOT NULL,
  gross_pool_pence BIGINT NOT NULL CHECK (gross_pool_pence >= 0),
  tvc_adjustment_pence BIGINT NOT NULL DEFAULT 0,
  amount_after_tvc_pence BIGINT NOT NULL CHECK (amount_after_tvc_pence >= 0),
  platform_fee_bps INTEGER NOT NULL CHECK (platform_fee_bps >= 0),
  platform_fee_pence BIGINT NOT NULL CHECK (platform_fee_pence >= 0),
  net_payout_pence BIGINT NOT NULL CHECK (net_payout_pence >= 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'paid', 'failed', 'reversed')),
  idempotency_key TEXT NOT NULL UNIQUE,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (recipient_member_id, tenant_id)
    REFERENCES tenant_members(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT payout_amount_components_valid
    CHECK (gross_pool_pence + tvc_adjustment_pence = amount_after_tvc_pence
       AND amount_after_tvc_pence - platform_fee_pence = net_payout_pence),
  CONSTRAINT payout_position_unique UNIQUE (tenant_id, collection_position)
);

CREATE TABLE payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_intent_id UUID NOT NULL UNIQUE REFERENCES payout_intents(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'reversed')),
  payment_provider TEXT,
  payment_reference TEXT,
  paid_at TIMESTAMPTZ,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE pool_account_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  external_account_reference TEXT NOT NULL,
  account_name TEXT,
  masked_account_identifier TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (branch_id, provider, external_account_reference)
);

CREATE TABLE ledger_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT,
  transaction_type TEXT NOT NULL,
  amount_pence BIGINT NOT NULL CHECK (amount_pence <> 0),
  currency CHAR(3) NOT NULL DEFAULT 'GBP',
  reference_type TEXT NOT NULL,
  reference_id UUID NOT NULL,
  external_reference TEXT,
  status TEXT NOT NULL DEFAULT 'recorded'
    CHECK (status IN ('recorded', 'reconciled', 'reversed')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contribution_id UUID REFERENCES contributions(id) ON DELETE RESTRICT,
  payout_id UUID REFERENCES payouts(id) ON DELETE RESTRICT,
  storage_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  uploaded_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT receipt_has_one_financial_reference CHECK (
    (contribution_id IS NOT NULL AND payout_id IS NULL)
    OR (contribution_id IS NULL AND payout_id IS NOT NULL)
  )
);

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('sms', 'email', 'push', 'in_app')),
  notification_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE lifecycle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID REFERENCES branches(id) ON DELETE RESTRICT,
  tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  previous_state TEXT,
  new_state TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX tenants_branch_status_idx ON tenants(branch_id, status);
CREATE INDEX tenants_configuration_status_idx ON tenants(configuration_id, status);
CREATE INDEX tenant_members_user_idx ON tenant_members(user_id);
CREATE INDEX contribution_periods_due_idx ON contribution_periods(due_at) WHERE status IN ('scheduled', 'open');
CREATE INDEX contributions_tenant_status_idx ON contributions(tenant_id, status);
CREATE INDEX payout_intents_tenant_status_idx ON payout_intents(tenant_id, status);
CREATE INDEX ledger_branch_occurred_idx ON ledger_transactions(branch_id, occurred_at DESC);
CREATE INDEX lifecycle_entity_idx ON lifecycle_events(entity_type, entity_id, created_at DESC);
CREATE INDEX notifications_pending_idx ON notifications(status, scheduled_at) WHERE status = 'pending';
