# Sharda Library — Backend Setup & API Integration

## Requirements
- Windows 10/11
- Node.js 20 or newer
- A new, empty Supabase project/database for this clean setup (recommended), or an existing project whose schema has been backed up and reviewed
- Node.js 20+; Vercel deployment uses the serverless adapter in `api/[...path].js`

## Fresh Supabase database setup (recommended)
The clean setup can start with empty student records. Create a NEW Supabase project (or a separate empty database) for Sharda Library. Do not delete or reset the old project as part of this setup; keep it untouched until the new project has been verified. Never share `.env`, `DATABASE_URL`, MSG91 keys, or passwords in chat.

1. Create a new Supabase project and keep its database credentials private.
2. Open the new project's SQL Editor.
3. Review and run `migrations/000_core_schema.sql` first. It creates the seven core application tables and enables RLS; it does not drop or truncate anything.
4. Then review and run `migrations/001_server_extensions.sql` for backups, private student photos and audit events.
5. Review and run `migrations/002_serverless_state.sql` for durable sessions, OTP verification state and shared rate limits. This is additive and does not delete or rewrite student/fee records.
6. Do not create `anon`, `authenticated`, or `public` policies on these tables. The Node.js server accesses them through the private PostgreSQL connection only.
7. Configure the new project's private connection string in `.env` as `DATABASE_URL`, then run `npm run check:schema`. This is a read-only check; it does not modify the database.
8. Configure `ADMIN_ID`, `ADMIN_PASSWORD` (at least 12 characters), and `ADMIN_MOBILE` (10-digit Indian mobile number) in `.env`. On first start, the fixed Admin ID is seeded from these values.

If you choose to reuse an existing Supabase project instead, take a full database backup first and inspect its schema. The migrations use `CREATE TABLE IF NOT EXISTS`, but they do not reconcile incompatible pre-existing table definitions. The schema checker must pass before starting the app.

The backend checks that all expected tables exist and RLS is enabled at startup; it stops with a clear error if the setup is incomplete. Run `npm run check:schema` after applying all three migrations.

## Install and run locally
1. Extract the project into a new folder.
2. Copy your existing `.env` into the project folder; do not overwrite it with `.env.example`.
3. Run `npm ci`.
4. Run `npm start`.
5. Open `http://127.0.0.1:3000/api/health`. With the Supabase connection configured, it must report `database: supabase`. If it reports `local-json`, it is using local fallback data and is not connected to Supabase.
6. Open `http://127.0.0.1:3000` and sign in using the existing fixed Admin ID and password.

## API routes

### Admin authentication
- `POST /api/auth/login` — fixed Admin ID + password; no OTP at login.
- `GET /api/auth/session` — current admin session.
- `POST /api/auth/logout` — revoke current session.
- `POST /api/auth/forgot-password/send-otp`
- `POST /api/auth/forgot-password/resend-otp` — resends the same active OTP through MSG91 retry.
- `POST /api/auth/forgot-password/verify-otp`
- `POST /api/auth/forgot-password/reset`
- `POST /api/auth/change-password/send-otp`
- `POST /api/auth/change-password/resend-otp` — resends the same active OTP through MSG91 retry.
- `POST /api/auth/change-password/verify-otp`
- `POST /api/auth/change-password` — requires the short-lived, single-use, session-bound token returned after OTP verification.

### Library data and bookings
- `GET /api/data` and `PUT /api/data` — admin-only persistent data. The write API validates student IDs/seats, rejects stale device versions, preserves newly submitted public booking requests, and keeps expired-but-not-ended memberships occupying their seat.
- `POST /api/booking-requests` — public booking request submission.
- `GET /api/booking-status` — public status check using Booking ID and mobile number.
- `POST /api/booking-requests/approve` — protected server-side approval and seat allocation.
- `POST /api/booking-requests/reject` — protected server-side rejection.

### Admin tools
- `POST /api/photos` and `GET /api/photos/:id` — private student photo upload/read. JPG, PNG and WebP only; maximum 2 MB; image signatures are checked.
- `GET /api/stats` — dashboard/server statistics.
- `GET /api/fees/due` — students with renewal fees due.
- `GET /api/audit` — recent activity events; passwords and OTP values are never logged.
- `GET/POST /api/backups` — list and create server backups.
- `GET /api/backups/:name` — download a backup.
- `POST /api/backups/:name/restore` — restore after validating the backup and creating a safety backup.

Server backups embed student photo bytes so restoring to a different server does not leave broken photo references. Browser JSON export also downloads photo bytes, and its restore flow creates a server safety backup before replacing data. The server keeps the latest 60 backups with unique timestamped names. Daily automatic and pre-save/pre-restore backups are supported.

## MSG91 OTP setup
Real SMS requires an MSG91 account, an approved OTP template containing the `##OTP##` variable (with required sender/DLT configuration for your account), and private `.env` values:
- `MSG91_AUTH_KEY`
- `MSG91_TEMPLATE_ID`

The registered admin mobile is used for password-change and recovery OTPs. Resend controls use MSG91’s OTP retry endpoint so the active OTP is resent rather than issuing a different code. Resend is limited to two attempts per 15 minutes, consistent with MSG91’s documented maximum of two retries. Normal login never requires OTP. Sessions expire after 8 hours maximum or 2 hours of inactivity. Real SMS delivery has not been confirmed until the owner configures valid MSG91 credentials and tests a real phone.

For local-only development, `DEV_FAKE_OTP=true` prints a temporary OTP in the server console. This option is ignored in production and when MSG91 credentials are present. Never enable or rely on fake OTP for a public deployment. For Vercel, set `TRUST_PROXY=true` so audit and shared rate-limit records use the forwarded client IP. For local development, leave it `false`.

## Automated API checks
Run `npm run test:api`. The test suite starts temporary local servers with isolated test data, including a production-mode security check; it does not connect to or modify the real Supabase project. It checks authentication, origin validation, duplicate seat rejection, booking approval/rejection, expired membership seat blocking, photo privacy, backup/restore, multi-device stale-write conflicts, and the three-step OTP password-change flow.

## Vercel deployment preparation

The Vercel API entry point is `api/[...path].js`; static assets remain at the project root. On Vercel, configure `DATABASE_URL` with the private Supabase PostgreSQL connection string (prefer the Supabase connection pooler for serverless use), plus the admin and OTP provider secrets. Set `TRUST_PROXY=true` in Vercel so request IP logging and rate limits use Vercel’s forwarded client IP. Configure `CRON_SECRET` as a long random value in the Production environment. The app intentionally refuses to start on Vercel without `DATABASE_URL`; it must never fall back to ephemeral local JSON storage. The PostgreSQL pool is limited to one connection per function instance.

For an existing Sharda Library Supabase database that already has migrations 000 and 001, take a database backup and apply only `migrations/002_serverless_state.sql` in the SQL Editor. Do not recreate the project, rerun data imports, or reset existing tables. Then run `npm run check:schema` from the project folder. For a fresh database, apply migrations 000, 001 and 002 in order. Admin sessions, password-reset/change grants, email OTP hashes, and rate-limit counters are stored in protected Supabase tables. Email OTP verification is consumed transactionally. Student-data commits use a database row lock and data-version compare-and-swap; stale server instances receive HTTP 409 instead of silently overwriting another instance's updates. Each API request refreshes its data snapshot before processing, and requests are serialized within each warm function instance.

Vercel does not run a persistent process timer. Daily backups are scheduled through Vercel Cron at `/api/internal/cron/backup`; configure a long random `CRON_SECRET` in Vercel. The endpoint accepts only `Authorization: Bearer <CRON_SECRET>`. Pre-save safety backups remain enabled.

This revision is a Vercel deployment candidate, not yet a production-approved release. Before production use, complete the live Supabase schema/connection test, verify migration 002 on the intended database, validate backups and restore against staging, verify real OTP delivery, confirm Vercel Cron execution, and run end-to-end browser tests. Never reset or recreate the existing Supabase database for this upgrade.


## Email OTP setup (default, `OTP_CHANNEL=email`)
Forgot-password and change-password OTPs are emailed to `ADMIN_EMAIL`. No DLT/SMS approval is needed; apply migration 002 so OTP verification survives serverless instance changes.

1. Use a Gmail account for sending. Turn on 2-Step Verification, then create an App Password at https://myaccount.google.com/apppasswords.
2. Put these in the private `.env` (never share it):
   - `OTP_CHANNEL=email`
   - `ADMIN_EMAIL=` the address that receives the OTP (can be the same Gmail or a different one)
   - `SMTP_USER=` the sending Gmail address
   - `SMTP_PASS=` the 16-character App Password (spaces are ignored)
   - `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465` (defaults)
3. Run `npm ci` (installs nodemailer), then `npm start`.
4. Forgot Password -> enter `ADMIN_EMAIL` -> OTP arrives (check Spam the first time).

Notes: OTP is 6 digits, valid 5 minutes, 5 wrong guesses allowed per code, and the hash is stored in protected Supabase state when using the database. Migration 002 is required for production persistence. Resend issues a NEW code and the old one stops working. For local testing without SMTP, set `DEV_FAKE_OTP=true` (non-production only) and read the OTP from the server console. Existing installations only need `ADMIN_EMAIL` and the SMTP values added; the admin record in Supabase is unchanged. To go back to SMS, set `OTP_CHANNEL=sms` and configure MSG91 and `ADMIN_MOBILE`.
