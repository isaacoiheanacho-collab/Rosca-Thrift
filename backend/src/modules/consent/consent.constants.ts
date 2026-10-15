/**
 * Consent constants — the single source of truth for document versions and
 * retention periods.
 *
 * When a document's text materially changes, bump the version here. The
 * register API rejects registrations that reference an old version, forcing
 * new sign-ups to consent to the current text.
 *
 * Existing users are NOT re-prompted automatically yet — that's a future
 * feature (a "document updated, please re-consent" flow). For now, they keep
 * their original accepted version.
 */

export const CONSENT_TYPES = {
  TERMS: 'TERMS',
  PRIVACY: 'PRIVACY',
  BRANCH_TERMS: 'BRANCH_TERMS',
} as const;

export type ConsentType = (typeof CONSENT_TYPES)[keyof typeof CONSENT_TYPES];

/**
 * Current document versions.
 * Bump these when the text changes.
 */
export const CONSENT_VERSIONS = {
  TERMS: '1.0.0',
  PRIVACY: '1.0.0',
} as const;

/**
 * Document slugs (used as the DB document_slug for platform-level documents).
 * Branch terms get a dynamic slug: `branch-terms:<branch-slug>`.
 */
export const CONSENT_SLUGS = {
  TERMS: 'terms',
  PRIVACY: 'privacy',
} as const;

/**
 * Data retention policy — displayed in the Privacy Policy and enforced
 * manually via admin tooling (not automated deletion yet).
 */
export const DATA_RETENTION = {
  /** Baseline for financial records — matches HMRC's 6-year window. */
  FINANCIAL_RECORDS_YEARS: 6,
  /** Longer window for anti-money-laundering and fraud-related records. */
  AML_RECORDS_YEARS: 10,
} as const;