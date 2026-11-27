# Sharda Library 3.0.0-rc.5

## UI updates
- Main application content now scrolls independently, so long pages/sections can be viewed without losing access to the top navigation.
- Admin sidebar navigation is independently scrollable when its links exceed the available screen height.
- Main top bar remains visible while scrolling the application content.
- Membership Expiry cards now use distinct dashboard-style gradients: red for Overdue, amber for Expires Today, blue for Expires Tomorrow, and teal for Next 5 Days.
- Existing expiry categories, student-list click behavior, membership status rules, and seat-blocking behavior are unchanged.

## Verification
- `node --check app.js` passed.
- `node --check server.js` passed.
- `npm run test:api` passed: 10 schema/migration checks, 35 API regression checks, and 3 production security checks.
- Supabase live integration and MSG91 SMS delivery still require environment-specific testing.
