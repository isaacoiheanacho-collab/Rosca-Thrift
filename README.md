# ROSCA

Multi-tenant rotating savings (ROSCA) ledger platform.

## Structure

- `backend/` — Express + Postgres API
- `frontend/` — plain HTML/CSS/JS PWA (scaffolded later)

## Backend quick start

```bash
cd backend
npm install
cp .env.example .env    # fill in real values
npm run migrate
npm run dev