# ROSCA Backend

Express + Postgres API for the ROSCA (rotating savings) ledger platform.
Read-only bank integration. Admin initiates payouts manually. This backend
only reconciles webhooks into an append-only ledger.

## Stack

- Node 20+, TypeScript strict, CommonJS
- Express 5, `pg` (raw SQL, no ORM), Zod validation
- pino structured logging, request IDs, helmet, CORS allowlist, rate limiting
- JWT access + rotating refresh tokens (with reuse detection)
- bcryptjs (cost 10), Cloudinary for receipt uploads (later)
- Postgres (Neon) - schema managed by numbered `.sql` files in `src/sql/`

## Setup

```bash
npm install
cp .env.example .env
# edit .env with your Neon DATABASE_URL + JWT secrets
npm run migrate
npm run dev