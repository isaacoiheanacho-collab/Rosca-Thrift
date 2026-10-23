/**
 * Default branch content — returned when a branch has not yet written
 * their own About / Terms / Privacy.
 *
 * Branches inherit these on onboarding. They can edit them later via the
 * branch admin dashboard. The platform's own Terms/Privacy sit underneath,
 * so a branch using the defaults is still legally covered.
 */

export const DEFAULT_BRANCH_ABOUT = `We are a savings circle running on ROSCA Thrift & Savings.

Our branch runs 12-member circles. Each member contributes the same amount every month. Each month, one member receives the entire pool. Over 12 months, every member contributes the same total, and every member receives the pool exactly once.

Slots are assigned randomly when the circle forms. Contributions and payouts are verified by our branch admin. Every transfer is recorded in a shared ledger that all members can see.

If you have been invited to join, please read our terms and privacy policy below, and the platform's terms and privacy policy. Then agree, and register.`;

export const DEFAULT_BRANCH_TERMS = `These are the standard membership terms for this branch.

1. Membership
You must complete identity verification (KYC) before joining a circle. We collect your full legal name, home address, phone number, and bank details.

2. Contributions
You agree to contribute the amount set by this branch on or before the deadline each month. Contributions are made by bank transfer to our branch's pool account.

3. Payouts
Your position in the circle (your "slot") determines which month you receive the pool. Slot numbers are assigned randomly. Early receivers get a slight discount and late receivers get a slight bonus, calculated as Time-Value Contribution (TVC) at 2% per year.

4. Default
If you miss a contribution, we will contact you. If you continue to miss contributions, we may need to replace you in the circle so that other members are not affected.

5. Renewal
After 12 months, every member votes on whether to continue for another year. All members must agree to renew. If you decline, you will be removed and replaced.

6. Leaving
You cannot leave the circle mid-tenure. At the end of a tenure you may decline renewal. This protects every other member's contribution and payout.

7. Disputes
If you have a dispute, contact your branch admin first. If that does not resolve it, contact the platform operator using the details in their Privacy Policy.`;

export const DEFAULT_BRANCH_PRIVACY = `This branch privacy notice explains how we handle your personal data.

1. What we collect
- Your full legal name
- Your home address
- Your phone number
- Your bank account details (for payouts)
- A photograph of you (selfie for identity verification)
- Records of every contribution, receipt, payout, and confirmation

2. Why we collect it
- To verify your identity (required by UK financial-record rules)
- To route your contributions and payouts correctly
- To give every member of the circle visibility of the shared ledger
- To comply with legal and tax obligations

3. Who can see it
- Your branch admin (for verifying your contributions and confirming payouts)
- Other members of your circle (only: your name, your slot, whether you have contributed this month)
- The platform operator (Thrifty Technologies) in aggregate for support and audit purposes

Your bank account details and selfie are visible only to your branch admin and the platform operator. They are never shown to other members.

4. How long we keep it
We keep your financial records for at least 6 years after your account closes, and up to 10 years for anti-money-laundering and fraud-related records.

5. Your rights
You have the right to access, correct, delete, restrict, or object to our use of your data, and to withdraw consent. Contact your branch admin first, then the platform operator if needed.

6. Platform terms apply
The platform's own Privacy Policy at /privacy.html also applies to how Thrifty Technologies processes your data as the software operator.`;

export const BRANCH_CONTENT_DEFAULT_VERSIONS = {
  ABOUT: '1.0.0',
  TERMS: '1.0.0',
  PRIVACY: '1.0.0',
} as const;