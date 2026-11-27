# ROSCA backend

Express 5 + TypeScript + PostgreSQL API rebuilt around the current dynamic circle-configuration model.

## Domain rules

- A branch owns multiple distinct configurations. Identical terms do not merge configuration identities.
- Each configuration defines contribution amount (integer pence), weekly/monthly frequency, co-saver capacity, collection positions and duration.
- For one payout per member, collection positions and duration periods equal configured capacity.
- Configuration financial terms are immutable. Changed terms require a new configuration.
- Every tenant belongs to exactly one branch and configuration. Tenant sequences are independent per configuration.
- Member allocation locks the selected configuration, preventing duplicate positions under concurrent joins.
- A full tenant moves to `awaiting_verification`; the next tenant is created immediately under that same configuration.
- Activation requires full capacity, completed onboarding, approved verification and verified phone for every member.
- Schedules start at actual activation. Period one opens then; the next period opens only after all contributions for the current period are reconciled.
- Monthly schedule boundaries use PostgreSQL month intervals, including month-end clamping.

## TVC and payout arithmetic

All amounts are integer pence. Gross pool per collection period = configured contribution × configured capacity.

For contribution `C`, capacity `N > 1`, and 1-based position `p`:

`TVC = round(C × (2p − N − 1) / (2 × (N − 1)))`

Round to the nearest penny, with half-penny ties away from zero, then cap the result at the largest whole-penny amount not exceeding half the contribution. This preserves the strict 50% cap for odd-penny contributions. Mirrored positions are opposites and adjustments sum to zero. Capacity one has zero adjustment. A £100 contribution and five positions produce -£50, -£25, £0, +£25, +£50. The maximum absolute adjustment is 50% of one contribution, not 50% of the gross pool.

Each payout records gross pool, TVC adjustment, amount after TVC, platform fee and net payout separately. The maintenance fee is **0.5% (50 basis points)** of the amount after TVC. The old 1.5% fee and old annual TVC rates are not used. The platform does not hold the savings pool; funds remain in the branch-admin-controlled account.

## Authentication

- `POST /api/auth/otp/request` — `{ "phone": "+44..." }`
- `POST /api/auth/otp/verify` — `{ "phone": "+44...", "code": "123456" }`
- `POST /api/auth/refresh` — `{ "refreshToken": "..." }`
- `POST /api/auth/logout` — `{ "refreshToken": "..." }`
- `GET /api/auth/me` — bearer access token required
- `POST /api/auth/super-admin/bootstrap` — requires a verified phone matching `SUPER_ADMIN_PHONE` and `SUPER_ADMIN_REGISTRATION_SECRET; refresh the session after promotion.

OTP hashes are keyed, short-lived and attempt-limited. Refresh tokens are stored as hashes and rotated on use. Authenticated routes use `Authorization: Bearer <accessToken>`.

## Implemented routes

| Method | Route | Purpose |
|---|---|---|
| GET/PATCH | `/api/users/me` | Read/update member profile |
| POST | `/api/branches` | Register branch; creator becomes branch admin |
| GET | `/api/branches/mine` | List administered branches |
| GET | `/api/circle-configurations/public` | List public active configurations |
| GET | `/api/circle-configurations/:configurationId` | Read public configuration |
| POST | `/api/circle-configurations` | Create immutable configuration |
| GET | `/api/circle-configurations/branch/:branchId` | List branch configurations |
| POST | `/api/tenants/join` | Join configuration and allocate position |
| GET | `/api/tenants/:tenantId/schedule` | Read activation-anchored contribution/payout periods |
| POST | `/api/kyc` | Submit KYC provider/manual reference |
| GET | `/api/kyc/me` | Read own KYC submissions |
| GET | `/api/branch-admin/kyc/branch/:branchId/pending` | Branch KYC review queue |
| PATCH | `/api/branch-admin/tenants/:tenantId/members/:memberId/verification` | Review member; may activate group |
| POST | `/api/contributions` | Record pending contribution |
| PATCH | `/api/contributions/:contributionId/status` | Receive, fail or reconcile contribution |
| GET | `/api/contributions/tenant/:tenantId/progress` | Dynamic group progress |
| POST | `/api/branch-admin/payouts/intents` | Prepare payout after full reconciliation |
| PATCH | `/api/branch-admin/payouts/intents/:intentId/status` | Approve, pay, fail or reverse payout |
| POST/GET | `/api/branch-admin/pool-account` and `/:branchId` | Manage branch-controlled account references |
| GET | `/api/branch-admin/ledger/branch/:branchId` | Read branch-scoped ledger entries |
| GET | `/api/branch-admin/stats/branch/:branchId` | Dynamic branch statistics |
| GET/PATCH | `/api/notifications` and `/:notificationId/read` | Read and mark own in-app notifications |
| POST | `/api/receipts` | Upload private PDF/JPEG/PNG receipt (multipart field `file`) |
| GET | `/api/receipts/:receiptId` | Obtain a short-lived authorised download URL |

## Migrations

SQL migrations are in `src/sql`, applied lexically and transactionally, and tracked in `schema_migrations`.

- `001_initial_dynamic_schema.sql` — dynamic branch/configuration/tenant, membership, contribution, payout, ledger, KYC, pool reference, receipt, notification and lifecycle schema.
- `002_auth_sessions.sql` — OTP challenges and refresh-token sessions.
- `003_dynamic_integrity.sql` — database guards for configuration capacity, member positions, activation, completion, contribution amounts, period bounds and payout/TVC/fee arithmetic.
- `004_notification_read_state.sql` — in-app notification read tracking.

Run from `backend/`:

```sh
yarn migrate
```

The runner fails if the migration directory is missing or empty, or if a filename is invalid.

## Quality checks

Run from `backend/`:

```sh
yarn typecheck
yarn build
node --test tests/*.test.cjs
```

Or use `yarn test`. GitHub Actions runs type-check, build and tests on pushes to `main`.

## Environment

See `.env.example`. Database, Redis, object storage, JWT and TextBee values are validated at startup. `MAX_TENANTS` is an operational per-admin limit, not circle capacity. Contribution amount and capacity always come from the selected configuration. Never commit real secrets.
