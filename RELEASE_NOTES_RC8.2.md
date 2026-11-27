# Sharda Library RC8.2 — Vercel Static Frontend Hotfix

- Moved browser-only frontend assets (`index.html`, `app.js`, `style.css`, and images) into `public/` so they are served as static assets and are not treated as Node.js server entry points.
- Updated the local Node.js server to serve the same `public/` directory, preserving the Windows local development workflow.
- Updated API regression tests for the new public asset layout.
- Preserved the existing API handler, Supabase persistence, migrations, student data model, authentication, booking, membership, backup, and audit workflows.

## Verification
- Schema/migration guard checks passed.
- 43 API regression checks passed.
- 3 production security guard checks passed.
- Vercel adapter checks passed.

This release has not yet been deployed to Vercel. A successful production deployment and live Supabase/OTP/browser verification are still required.
