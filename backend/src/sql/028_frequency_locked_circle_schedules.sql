-- =============================================================================
-- 028_frequency_locked_circle_schedules.sql
-- Canonical schedule is determined exclusively by contribution frequency:
-- WEEKLY  = 5 contribution days, 7-day cycle, payout on day 7.
-- MONTHLY = 21 contribution days, 30-day cycle, payout on day 30.
-- Historical payout records and completed tenants are not changed.
-- =============================================================================

-- Refresh active/filling tenant snapshots using the frequency rule, rather
-- than copying potentially stale day values from older configuration rows.
-- For active circles, recalculate only the current cycle's future deadlines
-- from its original start date.
UPDATE tenants t
SET contribution_window_days_snapshot = CASE
      WHEN c.contribution_frequency = 'WEEKLY' THEN 5 ELSE 21 END,
    cycle_duration_days_snapshot = CASE
      WHEN c.contribution_frequency = 'WEEKLY' THEN 7 ELSE 30 END,
    cycle_contribution_deadline_at = CASE
      WHEN t.status = 'ACTIVE' AND t.cycle_started_at IS NOT NULL
      THEN t.cycle_started_at + (
        CASE WHEN c.contribution_frequency = 'WEEKLY' THEN 5 ELSE 21 END
        * INTERVAL '1 day'
      )
      ELSE t.cycle_contribution_deadline_at
    END,
    cycle_ends_at = CASE
      WHEN t.status = 'ACTIVE' AND t.cycle_started_at IS NOT NULL
      THEN t.cycle_started_at + (
        CASE WHEN c.contribution_frequency = 'WEEKLY' THEN 7 ELSE 30 END
        * INTERVAL '1 day'
      )
      ELSE t.cycle_ends_at
    END,
    cycle_payout_at = CASE
      WHEN t.status = 'ACTIVE' AND t.cycle_started_at IS NOT NULL
      THEN t.cycle_started_at + (
        CASE WHEN c.contribution_frequency = 'WEEKLY' THEN 7 ELSE 30 END
        * INTERVAL '1 day'
      )
      ELSE t.cycle_payout_at
    END
FROM circle_configurations c
WHERE t.configuration_id = c.id
  AND t.status IN ('FILLING', 'ACTIVE');
