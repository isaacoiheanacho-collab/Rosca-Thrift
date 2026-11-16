-- Allow a Branch Admin's registration-created KYC draft to exist before
-- bank details and selfie are supplied. Drafts are never reviewable as submissions.
ALTER TABLE kyc_submissions
  ALTER COLUMN selfie_object_key DROP NOT NULL,
  ALTER COLUMN bank_name DROP NOT NULL,
  ALTER COLUMN account_number DROP NOT NULL,
  ALTER COLUMN sort_code DROP NOT NULL;

ALTER TABLE kyc_submissions
  DROP CONSTRAINT IF EXISTS kyc_submissions_status_check;

ALTER TABLE kyc_submissions
  ADD CONSTRAINT kyc_submissions_status_check
  CHECK (status IN ('NOT_SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED'));
