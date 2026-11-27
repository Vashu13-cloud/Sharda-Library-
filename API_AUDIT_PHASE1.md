# Sharda Library API Audit — Phase 1

Date: 2026-11-22

## Scope
Compared the two supplied project archives:
- `Sharda_Library_Supabase_Backend_Phase2(1).zip` — chosen base candidate
- `Buuggu_Steps_UI(1).zip` — source of additional backend capabilities

Original archives were not modified. Tests ran against temporary extracted copies with local JSON storage and test-only credentials.

## API surface comparison

| Capability | Supabase Phase 2 | Buuggu Steps UI | Integration direction |
|---|---|---|---|
| Health | `GET /api/health` | `GET /api/health` | Keep; report actual storage health accurately |
| Admin login/session/logout | Present | Present | Keep Supabase flow; strengthen session persistence for production |
| Forgot password | send OTP, verify OTP, reset | same | Keep; standardize rate limits and token lifecycle |
| Change password | send OTP then combined OTP+password update | send OTP, verify OTP, then password update with session-bound one-time token | Adopt Buuggu's explicit 3-step verification flow |
| Data read/write | `GET/PUT /api/data` | `GET/PUT /api/data` | Keep Supabase data model; port validation, safe merge and write serialization carefully |
| Booking create/status | Present | Present | Keep Supabase endpoints |
| Booking approve/reject | Protected server endpoints | Client-side state mutation then generic data save | Keep Supabase server endpoints; do not port Buuggu client-side approval logic |
| Photos | Missing | upload/read API | Add private photo endpoints and persistent Supabase-compatible storage |
| Stats | Missing | `GET /api/stats` | Add |
| Fees due | Missing | `GET /api/fees/due` | Add |
| Audit | Docs mention `library_audit_log`, but API does not implement it | `GET /api/audit` and write events | Add durable audit event storage and API |
| Backups | Missing | list/create/download/restore APIs | Add durable backup storage and safe restore flow |

## Temporary API smoke-test results

### Supabase Phase 2
- Health: 200
- Unauthenticated `/api/data`: 401
- Admin login: 200
- Authenticated session: true
- Authenticated `/api/data`: 200
- Public booking create: 201
- Server booking approval: 200
- Server booking rejection: 200
- Unauthenticated booking approval: 401
- `/api/stats`: 404 (not implemented)
- `/api/backups`: 404 (not implemented)
- `/api/auth/change-password/verify-otp`: 404 (not implemented)
- Duplicate active seat data accepted by `PUT /api/data`: 200 (validation gap confirmed)
- Cross-origin booking POST accepted: 201 (Origin guard gap confirmed)

### Buuggu Steps UI
- Health: 200
- Unauthenticated `/api/data`: 401
- Admin login: 200
- Authenticated session: true
- Authenticated `/api/data`: 200
- Public booking create: 201
- `/api/stats`: 200
- `/api/fees/due`: 200
- `/api/audit`: 200
- Manual backup create/list/download/restore: 201/200/200/200
- Photo upload and authenticated read: 201/200 (`image/png`)
- Change-password OTP send/verify/update: 200/200/200
- Old password rejected after update: 401
- New password accepted after update: 200
- Duplicate active seat data rejected by `PUT /api/data`: 400
- Cross-origin booking POST rejected: 403
- `/api/booking-requests/approve`: 404 (not implemented; approval is client-side in this build)

All temporary test folders were removed after the tests. No real MSG91 SMS was sent; Buuggu's local-only `DEV_FAKE_OTP` was used for the password-flow smoke test.

## High-priority integration risks found

1. **Supabase persistence currently rewrites whole collections:** `persist()` deletes and reinserts all rows in each `library_*` collection on every save. This is transactional in one database connection, but it is not a safe multi-instance concurrency strategy and can overwrite concurrent changes from another running process.
2. **Supabase data API lacks Buuggu validation and safe booking merge:** the Supabase `PUT /api/data` accepts arrays but does not validate duplicate IDs/seats or preserve public booking requests that arrived after the admin last loaded data. Confirmed by test: duplicate active seat data was accepted by Supabase (200), while Buuggu rejected it (400).
3. **Supabase API lacks same-origin mutation guard:** Buuggu checks request Origin for state-changing methods; Supabase handler does not currently do this. Confirmed by test: a cross-origin public booking POST was accepted by Supabase (201) and rejected by Buuggu (403).
4. **Booking approval must remain server-side:** Buuggu's frontend changes booking status and allocates seats in browser memory. The Supabase protected endpoints are safer and must be retained, then strengthened for concurrent seat allocation.
5. **OTP flow mismatch:** Buuggu's 3-step password-change flow creates a short-lived, single-use token bound to the authenticated session. Supabase currently combines OTP verification and password update in one request. Use the explicit 3-step flow.
6. **Storage schema mismatch:** Buuggu `PostgresStore` creates generic tables (`meta`, `students`, `photos`, `backups`, `audit_log`). Supabase version uses `public.library_*` tables. Do not copy Buuggu SQL/table assumptions into the existing Supabase project.
7. **No live schema verification yet:** the Supabase setup guide names the current `library_*` tables but does not include a schema migration file or full column definitions. A live DB connection or confirmed schema export is needed before final migration design.
8. **Backup/photo completeness needs correction:** Buuggu backup snapshots preserve student photo URLs, but its `createBackup()` does not embed the photo bytes. A restore onto a different host could therefore restore broken photo references unless the photo files are moved separately. Final backups should be self-contained or include a verified photo bundle.
9. **Deployment limitation remains:** Supabase setup guide explicitly says current server entry point and in-memory session store are not Vercel-ready and need multi-instance-safe work.

## Next API implementation plan

1. Define a Supabase-compatible persistence contract for backups, photos and audit events; add a reviewed SQL migration instead of creating Buuggu's generic tables.
2. Port Buuggu's 3-step OTP password-change contract and keep fixed Admin ID/password-only login.
3. Add photo endpoints with image signature/size validation and admin-only reads.
4. Add stats, fees-due, audit, backup list/create/download/restore endpoints.
5. Harden `PUT /api/data`: schema validation, seat uniqueness, booking merge, same-origin checks and explicit optimistic concurrency behavior.
6. Strengthen server-side booking approve/reject with transaction-level seat uniqueness and audit events.
7. Add API tests for success, unauthorized, invalid input, race/conflict, restore safety and expired membership seat blocking.

## Current status

- Static syntax checks: passed for both servers, Buuggu storage module and both client scripts.
- Temporary local API smoke tests: passed for tested happy-path flows.
- Real Supabase database integration: not yet tested; no live DB schema/credentials were supplied in the archives.
- Real MSG91 delivery: not tested; requires the user's private provider configuration.
- Merge implementation: not started; this phase is the compatibility audit only.
