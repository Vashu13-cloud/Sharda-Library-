# Sharda Library RC.8.1 — Vercel serverless preparation

## Added
- Added `api/[...path].js` as the Vercel Node.js serverless API entry point while preserving the local `node server.js` workflow.
- Added fail-closed startup on Vercel when `DATABASE_URL` is missing; the app will not silently use ephemeral local JSON storage.
- Added additive migration `migrations/002_serverless_state.sql` for protected durable authentication state and shared rate-limit counters.
- Admin sessions, password reset/change grants, email OTP hashes, and rate limits now use Supabase-backed state when `DATABASE_URL` is configured. OTP hash verification is consumed transactionally.
- Added database-level version locking around whole-snapshot writes. Competing server instances cannot silently overwrite each other's data; a stale write receives HTTP 409.
- API requests refresh the current Supabase snapshot before processing and serialize within each warm instance.
- Added Vercel Cron daily backup endpoint, `CRON_SECRET` protection, and Vercel security headers.
- Added `.vercelignore` so local `.env`, `data/`, `node_modules/`, tests, and logs are not packaged for deployment.

## Preserved
- Existing student, fee, seat, former-student, booking, membership-expiry, photo, backup/restore, and admin UI behavior.
- Existing Supabase tables and rows are not dropped, truncated, or reset by migration 002.

## Validation
- `node --check` passed for the changed JavaScript files.
- `npm run test:api` passed: 12 schema/RLS migration checks, 43 API regression checks, 3 production guard checks, and the Vercel adapter/no-database guard check.
- Live Supabase execution of migration 002, database-backed multi-instance concurrency, real SMTP/MSG91 delivery, Vercel Cron execution, and live production browser testing have not been performed in this workspace. These remain required before public production use.


## RC8.2 deployment hotfix
- Isolated browser assets under `public/` so browser-only JavaScript is deployed as static content rather than being considered a Node.js entry point.
- Updated the local Node.js static-file handler to serve the same `public/` directory, preserving Windows local development.
- Extended Vercel adapter regression checks to verify the static asset layout and frontend references.
