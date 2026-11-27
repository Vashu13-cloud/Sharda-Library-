'use strict';

// Read-only check of the existing Supabase tables expected by server.js.
// This script does not create, alter, truncate or delete any table or row.
const { Pool } = require('pg');

const requiredColumns = {
  library_meta: ['id', 'schema_version', 'data_version', 'updated_at'],
  library_admin: ['id', 'password_salt', 'password_hash', 'mobile', 'created_at', 'password_changed_at'],
  library_students: ['record_id', 'payload', 'created_at'],
  library_half_visits: ['record_id', 'payload', 'created_at'],
  library_booking_requests: ['record_id', 'payload', 'created_at'],
  library_seat_history: ['record_id', 'payload', 'created_at'],
  library_settings: ['setting_key', 'setting_value'],
  library_server_backups: ['name', 'size_bytes', 'content', 'created_at'],
  library_student_photos: ['id', 'mime_type', 'image_data', 'created_at'],
  library_audit_events: ['id', 'created_at', 'event', 'ip', 'detail'],
  library_auth_state: ['state_key', 'state_value', 'expires_at', 'updated_at'],
  library_rate_limits: ['bucket_key', 'hit_count', 'window_started_at', 'expires_at']
};

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is missing. Copy your private .env and configure the Supabase connection first.');
    process.exitCode = 2;
    return;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1, connectionTimeoutMillis: 10000 });
  try {
    const names = Object.keys(requiredColumns);
    const result = await pool.query(
      `SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name = ANY($1::text[])`,
      [names]
    );
    const found = new Map();
    for (const row of result.rows) {
      if (!found.has(row.table_name)) found.set(row.table_name, new Set());
      found.get(row.table_name).add(row.column_name);
    }
    const missing = [];
    for (const [table, columns] of Object.entries(requiredColumns)) {
      for (const column of columns) if (!found.get(table)?.has(column)) missing.push(`${table}.${column}`);
    }
    const protectedTables = Object.keys(requiredColumns);
    const rls = await pool.query(
      `SELECT c.relname,c.relrowsecurity FROM pg_class c WHERE c.oid IN (
        SELECT to_regclass('public.' || t.name) FROM unnest($1::text[]) AS t(name)
      )`, [protectedTables]
    );
    const secure = new Set(rls.rows.filter(row => row.relrowsecurity).map(row => row.relname));
    for (const table of protectedTables) if (!secure.has(table)) missing.push(`${table} (RLS enabled)`);
    const policies = await pool.query(`SELECT tablename,policyname,roles FROM pg_policies WHERE schemaname='public' AND tablename = ANY($1::text[])`, [protectedTables]);
    for (const row of policies.rows) if ((row.roles || []).some(role => ['public','anon','authenticated'].includes(String(role).toLowerCase()))) missing.push(`${row.tablename} policy ${row.policyname} (no public/anon/authenticated access)`);
    if (missing.length) {
      console.error('Supabase schema check FAILED. Missing columns/tables or disabled RLS:');
      for (const item of missing) console.error(' - ' + item);
      console.error('Review the existing schema before running the application. The checker did not modify the database.');
      process.exitCode = 1;
      return;
    }
    console.log('Supabase schema check PASSED. All expected columns exist, RLS is enabled on every application table, and no client-role policies were found.');
    console.log('Read-only check complete; no database data or schema was changed.');
  } finally {
    await pool.end();
  }
}

main().catch(error => { console.error('Supabase schema check failed:', error.message); process.exitCode = 1; });
