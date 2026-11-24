-- =============================================================================
-- 028_frequency_locked_circle_schedules.sql
-- Canonical schedule is determined exclusively by contribution frequency:
-- WEEKLY  = 5 contribution days, 7-day cycle, payout on day 7.
-- MONTHLY = 21 contribution days, 30-day cycle, payout on day 30.
-- Existing historical payout records are not changed.
-- =============================================================================

UPDATE circle_configurations
SET contribution_window_days = CASE
      WHEN contribution_frequency = 'WEEKLY' THEN 5
      ELSE 21
    END,
    cycle_duration_days = CASE
      WHEN contribution_frequency = 'WEEKLY' THEN 7
      ELSE 30
    END
WHERE contribution_window_days IS DISTINCT FROM CASE
        WHEN contribution_frequency = 'WEEKLY' THEN 5 ELSE 21 END
   OR cycle_duration_days IS DISTINCT FROM CASE
        WHEN contribution_frequency = 'WEEKLY' THEN 7 ELSE 30 END;

-- Keep unfilled tenant snapshots aligned with their configuration. For active
-- tenants, correct only the current cycle's schedule timestamps from its
-- original start; completed tenants and historical payouts remain untouched.
UPDATE tenants t
SET member_capacity_snapshot = c.member_capacity,
    contribution_window_days_snapshot = c.contribution_window_days,
    cycle_duration_days_snapshot = c.cycle_duration_days,
    cycle_contribution_deadline_at = CASE
      WHEN t.status = 'ACTIVE' AND t.cycle_started_at IS NOT NULL
      THEN t.cycle_started_at + (c.contribution_window_days * INTERVAL '1 day')
      ELSE t.cycle_contribution_deadline_at
    END,
    cycle_ends_at = CASE
      WHEN t.status = 'ACTIVE' AND t.cycle_started_at IS NOT NULL
      THEN t.cycle_started_at + (c.cycle_duration_days * INTERVAL '1 day')
      ELSE t.cycle_ends_at
    END,
    cycle_payout_at = CASE
      WHEN t.status = 'ACTIVE' AND t.cycle_started_at IS NOT NULL
      THEN t.cycle_started_at + (c.cycle_duration_days * INTERVAL '1 day')
      ELSE t.cycle_payout_at
    END
FROM circle_configurations c
WHERE t.configuration_id = c.id
  AND t.status IN ('FILLING', 'ACTIVE');
