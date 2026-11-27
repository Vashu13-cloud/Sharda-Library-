# Sharda Library — Reading Room Management System

A browser-based reading-room management system built with HTML, CSS, JavaScript, Node.js and Supabase PostgreSQL. It manages student membership, assigned seats, half-time visits, fees, former-student history and online booking requests.

## Main features
- Public library information and online booking request/status pages.
- Admin-only portal with fixed Admin ID and password; no student login.
- Password recovery and password change using an OTP emailed to the registered admin email (SMTP, e.g. Gmail App Password). SMS OTP through MSG91 is still available with `OTP_CHANNEL=sms`.
- Student records with photos, monthly fee status, renewal reminders and printable receipts.
- 100-seat allocation; expired memberships continue to block their seats until the admin explicitly renews or marks the student Completed/Left.
- Separate half-time visit records.
- Active and Completed/Left student history.
- Protected server-side booking approval/rejection.
- Private student photo storage, daily/manual backups, safe restore and activity log. Browser JSON export also embeds student photos; restoring it creates a server safety backup first.
- Dashboard statistics and fees-due API.

## Run locally
1. Install Node.js 20+.
2. Follow `BACKEND_SETUP.md` and configure a private `.env`.
3. Run `npm ci`.
4. Run `npm run check:schema` to verify the configured Supabase schema without changing it.
5. Run `npm start`.
6. Open `http://127.0.0.1:3000`.

Do not open `index.html` directly; the admin session, Supabase persistence, photos, bookings and backup APIs require the Node.js server.

## API regression tests
Run `npm run test:api`. Tests use a temporary local database and fake development OTP; they do not contact the real Supabase database or send real SMS.

## Deployment status
The browser frontend is isolated in `public/` for Vercel static hosting, while `api/[...path].js` is the only serverless entry point. The same `public/` assets are served by the local Node.js server. A Vercel serverless adapter is included. Admin sessions, password-reset/change grants, email OTP hashes and rate limits use protected Supabase state tables; student-data commits use database-level version locking to prevent cross-instance lost updates. Vercel Cron handles daily backups. Production approval still requires applying migration 002, passing the live Supabase schema check, verifying real OTP delivery and cron execution, and completing production browser tests. See `BACKEND_SETUP.md`.


## Fresh database setup
For a clean installation with empty student records, create a new empty Supabase project and run `migrations/000_core_schema.sql` followed by `migrations/001_server_extensions.sql` and `migrations/002_serverless_state.sql` in the Supabase SQL Editor. Then configure the private `.env` and run `npm run check:schema`. See `BACKEND_SETUP.md` for the full steps. Do not delete or reset an existing project to perform this setup.
