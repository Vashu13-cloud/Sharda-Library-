# Sharda Library Integrated Candidate — Work Log

Build: 3.0.0-rc.2
Date: 2026-11-22

## Phase 1 — Source/API audit
- Compared the Supabase Phase 2 project with Buuggu Steps UI.
- Confirmed Supabase server booking approval/rejection should be retained.
- Confirmed Buuggu's 3-step password-change OTP flow is stronger than the Supabase 2-step UI/API and ported the explicit verified-token flow.
- Confirmed Buuggu's generic PostgreSQL tables are not compatible with the existing `library_*` Supabase schema; no generic table schema was copied over.
- Deliberately did not port Buuggu's `reset-admin.js` utility because it can reset the fixed Admin ID and registered mobile, which conflicts with the approved fixed-ID requirement.

## Phase 2 — API integration candidate
Implemented in a separate working copy based on the Supabase Phase 2 project:
- Added a Supabase-compatible extension storage adapter for backups, private student photos and audit events.
- Added isolated SQL migration `migrations/001_server_extensions.sql` for `library_server_backups`, `library_student_photos`, and `library_audit_events`.
- Added private photo upload/read APIs with 2 MB limit and file-signature validation.
- Added `/api/stats`, `/api/fees/due`, and `/api/audit`.
- Added manual/daily/pre-save/pre-restore server backups, download and restore with a safety backup.
- Backups embed photo bytes so photos survive a move/restore to another server.
- Ported the 3-step change-password OTP flow with a short-lived, single-use token tied to the current admin session.
- Added same-origin checks for state-changing API requests.
- Added student ID/name/seat validation, duplicate active-seat rejection and booking-request merge protection to the data save API.
- Kept booking approval/rejection as protected server-side endpoints.
- Added in-process serialized snapshot persistence, stale-device version conflict behavior, and non-version-bumping public booking writes so new public requests survive the admin browser’s next save without creating a false conflict.
- Added an explicit public-file allowlist and security headers so internal backend modules, migrations and tests are not web-accessible.
- Added a read-only Supabase schema checker (`npm run check:schema`) that verifies required existing table columns and RLS on the new extension tables without changing the database.
- Updated admin Reports UI for server backups, activity log and statistics.
- Ported the forgot-password resend OTP and change-mobile controls, with one visible step at a time; resend actions use the provider retry flow.
- Updated student photo synchronization so the browser adopts server-side photo URLs after upload/save. Browser JSON backup now embeds photo bytes and restores directly to the server after creating a safety backup; seat history is preserved in the sync payload.
- Updated setup documentation, environment example and package scripts.
- Excluded the source ZIP's bundled local JSON snapshot from the integrated candidate because it contained a temporary test student plus admin hash/mobile metadata; the real Supabase database was not modified, and the server can create a clean local fallback file when needed.

## Tests completed
`npm run test:api` passed **38 isolated API/UI regression checks** (35 local API/UI checks + 3 production-mode security checks) using a temporary local-file environment:
- Admin login/session and protected data.
- Cross-origin mutation rejection.
- Duplicate active seat rejection.
- Expired-but-not-ended membership keeps its seat blocked.
- Server-side booking approval/rejection.
- Photo upload, type validation, private read access.
- Backup creation/list/download/restore and photo survival after restore.
- Stats, fees-due and audit APIs.
- Stale second-device save returns HTTP 409; a public booking does not falsely stale the admin data version and survives the next admin save.
- 3-step development OTP password change; old password revoked and new password accepted.
- Internal backend/test files are not served publicly.

JavaScript syntax checks passed for `server.js`, `extension-storage.js`, `app.js`, and the API test script.

## Phase 3 — Fresh Supabase schema preparation
- Added `migrations/000_core_schema.sql` to create the seven core `library_*` tables in a new empty Supabase database, with RLS enabled and no client-role policies.
- Updated the read-only schema checker to require RLS on all core and extension tables and reject client-role policies across all of them.
- Updated setup documentation to recommend a separate fresh Supabase project rather than wiping the current project. The old database is not modified.
- The fresh schema migration has not been executed against a live Supabase project because private credentials are not available in this workspace.

## RC8.0 verification gaps (superseded by the RC8.1 code changes below)
- At RC8.0, the new schema had not been executed against a live Supabase project and the extension adapter had not been tested with live credentials.
- Real MSG91 SMS delivery and full browser end-to-end testing were not available in this workspace.
- At RC8.0, collection writes, sessions and OTP grants were not safe for multiple serverless instances; RC8.1 adds database version locking and durable Supabase-backed state.
- Live database migration, real OTP delivery, Vercel Cron execution and production browser validation remain outstanding; see the RC8.1 section below.

## Safety boundary
The original two ZIP archives remain untouched. This integrated candidate uses a separate working directory and a temporary local database for tests. Do not connect it to the real Supabase project until the owner has backed up the database and reviewed/applied the migration in a controlled staging step.


## Candidate 3.0.0-rc.3 – Membership Expiry dashboard update (2026-11-23)

- Added four clickable Membership Expiry cards to the admin dashboard: Overdue, Expires Today, Expires Tomorrow, and Next 5 Days.
- Clicking a card opens a student list showing name, student ID, mobile, seat, expiry date, monthly fee, and a View / Edit action.
- Category logic uses active membership records only. Overdue means due date before today; today and tomorrow are their own categories; Next 5 Days means after tomorrow through the fifth calendar day from today (inclusive).
- Completed / Left records are excluded. An overdue membership remains active and continues to hold its seat; this dashboard view does not automatically renew, end membership, or release seats.
- Validation run: `node --check app.js` and `npm run test:api` passed (10 schema migration checks, 35 API regression checks, 3 production guard checks).
- Real Supabase migration, real MSG91 SMS delivery, and production deployment remain unverified and must be completed separately.

## Candidate 3.0.0-rc.4 – Dedicated Membership Expiry page (2026-11-23)

- Moved Membership Expiry out of the main Dashboard and created a dedicated admin page.
- Added a separate **Membership Expiry** item to the admin sidebar navigation; it is protected by the same admin-only page guard.
- Kept the four clickable category cards on that dedicated page: Overdue, Expires Today, Expires Tomorrow, and Next 5 Days.
- Each category still opens its matching student list with View / Edit. The expiry classification and seat-blocking rules are unchanged.
- Dashboard no longer embeds the Membership Expiry cards.
- Validation: `node --check app.js`, API regression checks, production security checks, and schema migration checks passed. This remains a candidate build; live Supabase, SMS and full browser E2E checks remain outstanding.


## RC8.1 — Vercel serverless preparation (2026-11-27)
- Added a Vercel catch-all API handler and retained local Node.js startup behavior.
- Added migration 002 for durable auth/OTP state and shared rate limits; it is additive and leaves existing student/fee rows untouched.
- Added persistent session/reset/change grants, transactional email OTP verification, and database-backed rate limits when Supabase is configured.
- Added a database row lock + data-version compare-and-swap to prevent silent multi-instance whole-snapshot overwrites.
- Added per-instance API request serialization and fresh Supabase reads before API processing.
- Added Vercel Cron daily backup route, secret guard, static security headers, and `.vercelignore`.
- Local automated suite passes: 12 schema/RLS checks, 43 API regression checks, 3 production guards, and Vercel adapter/no-database guard.
- Still outstanding: live application of migration 002 to the owner's existing Supabase project, `npm run check:schema` against that project, real OTP delivery, Cron execution, and production end-to-end browser verification. Do not mark production deployment approved until these pass.
