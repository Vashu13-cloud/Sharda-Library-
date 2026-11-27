'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const core = fs.readFileSync(path.join(root, 'migrations/000_core_schema.sql'), 'utf8');
const ext = fs.readFileSync(path.join(root, 'migrations/001_server_extensions.sql'), 'utf8');
const serverless = fs.readFileSync(path.join(root, 'migrations/002_serverless_state.sql'), 'utf8');
const checker = fs.readFileSync(path.join(root, 'scripts/check-supabase-schema.js'), 'utf8');
const coreTables = [
  'library_meta', 'library_admin', 'library_students', 'library_half_visits',
  'library_booking_requests', 'library_seat_history', 'library_settings'
];
const extensionTables = ['library_server_backups', 'library_student_photos', 'library_audit_events'];
const serverlessTables = ['library_auth_state', 'library_rate_limits'];
for (const table of coreTables) {
  assert.match(core, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\b`, 'i'), `core migration creates ${table}`);
  assert.match(core, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`, 'i'), `RLS enabled on ${table}`);
  assert.match(checker, new RegExp(`\\b${table}:`), `schema checker validates ${table}`);
}
for (const table of extensionTables) {
  assert.match(ext, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\b`, 'i'), `extension migration creates ${table}`);
  assert.match(ext, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`, 'i'), `RLS enabled on ${table}`);
  assert.match(checker, new RegExp(`\\b${table}:`), `schema checker validates ${table}`);
}
for (const table of serverlessTables) {
  assert.match(serverless, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\b`, 'i'), `serverless migration creates ${table}`);
  assert.match(serverless, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`, 'i'), `RLS enabled on ${table}`);
  assert.match(checker, new RegExp(`\\b${table}:`), `schema checker validates ${table}`);
}
for (const sql of [core, ext, serverless]) {
  assert.doesNotMatch(sql, /\b(DROP|TRUNCATE)\s+(TABLE|SCHEMA)\b/i, 'migrations must not drop or truncate existing data');
}
assert.match(checker, /no public\/anon\/authenticated access/i, 'checker rejects client-role policies');
console.log(`PASS: ${coreTables.length + extensionTables.length + serverlessTables.length} schema table definitions, RLS checks and non-destructive migration guards`);
