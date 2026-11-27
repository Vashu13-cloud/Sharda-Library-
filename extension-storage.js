'use strict';

// Durable storage for API modules added during the Buuggu -> Supabase integration.
// Existing library_* tables are intentionally left untouched. New tables are isolated
// behind this adapter and created by the reviewed migration in migrations/.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class ExtensionStorage {
  constructor({ pool = null, root = __dirname } = {}) {
    this.pool = pool;
    this.root = root;
    this.dataDir = path.join(root, 'data');
    this.photoDir = path.join(this.dataDir, 'photos');
    this.backupDir = path.join(this.dataDir, 'backups');
    this.auditFile = path.join(this.dataDir, 'audit.log');
    this.kind = pool ? 'supabase-extension-tables' : 'local-files';
  }

  async init() {
    if (!this.pool) {
      for (const dir of [this.dataDir, this.photoDir, this.backupDir]) fs.mkdirSync(dir, { recursive: true });
      return;
    }
    // Schema changes are explicit migrations, never silently applied by app startup.
    const result = await this.pool.query(`
      SELECT c.relname, c.relrowsecurity
      FROM pg_class c
      WHERE c.oid IN (
        to_regclass('public.library_server_backups'),
        to_regclass('public.library_student_photos'),
        to_regclass('public.library_audit_events'),
        to_regclass('public.library_auth_state'),
        to_regclass('public.library_rate_limits')
      )
    `);
    const required = new Set(['library_server_backups', 'library_student_photos', 'library_audit_events', 'library_auth_state', 'library_rate_limits']);
    for (const row of result.rows) if (row.relrowsecurity) required.delete(row.relname);
    if (required.size) {
      throw new Error('Supabase extension tables are missing or Row Level Security is disabled. Apply migrations/001_server_extensions.sql and migrations/002_serverless_state.sql in the Supabase SQL Editor, then restart the server.');
    }
    const policies = await this.pool.query(`
      SELECT tablename,roles FROM pg_policies
      WHERE schemaname='public' AND tablename = ANY($1::text[])
    `, [['library_server_backups', 'library_student_photos', 'library_audit_events', 'library_auth_state', 'library_rate_limits']]);
    const publicPolicies = policies.rows.filter(row => (row.roles || []).some(role => ['public', 'anon', 'authenticated'].includes(String(role).toLowerCase())));
    if (publicPolicies.length) {
      throw new Error('Supabase extension tables have a policy granting client-role access. Remove public/anon/authenticated policies; these tables must be accessed only by the private Node.js server.');
    }
  }


  async getAuthState(key) {
    if (!this.pool) return null;
    const result = await this.pool.query(
      'SELECT state_value, expires_at FROM public.library_auth_state WHERE state_key=$1 AND expires_at > now()',
      [String(key)]
    );
    return result.rows[0] ? result.rows[0].state_value : null;
  }

  async setAuthState(key, value, expiresAt) {
    if (!this.pool) return;
    await this.pool.query(
      `INSERT INTO public.library_auth_state (state_key,state_value,expires_at,updated_at)
       VALUES ($1,$2::jsonb,$3,now()) ON CONFLICT (state_key) DO UPDATE
       SET state_value=EXCLUDED.state_value,expires_at=EXCLUDED.expires_at,updated_at=now()`,
      [String(key), JSON.stringify(value), new Date(expiresAt).toISOString()]
    );
  }

  async deleteAuthState(key) {
    if (!this.pool) return;
    await this.pool.query('DELETE FROM public.library_auth_state WHERE state_key=$1', [String(key)]);
  }

  async verifyOtpHash(key, suppliedHash, maxAttempts = 5) {
    if (!this.pool) return false;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT state_value,expires_at FROM public.library_auth_state WHERE state_key=$1 FOR UPDATE', [String(key)]);
      const row = result.rows[0];
      if (!row || new Date(row.expires_at).getTime() <= Date.now()) {
        await client.query('DELETE FROM public.library_auth_state WHERE state_key=$1', [String(key)]);
        await client.query('COMMIT');
        return false;
      }
      const entry = row.state_value || {};
      entry.attempts = Number(entry.attempts || 0) + 1;
      const expected = Buffer.from(String(entry.hash || ''));
      const actual = Buffer.from(String(suppliedHash || ''));
      const good = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
      if (good || entry.attempts > maxAttempts) {
        await client.query('DELETE FROM public.library_auth_state WHERE state_key=$1', [String(key)]);
      } else {
        await client.query('UPDATE public.library_auth_state SET state_value=$2::jsonb,updated_at=now() WHERE state_key=$1', [String(key), JSON.stringify(entry)]);
      }
      await client.query('COMMIT');
      return good;
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    finally { client.release(); }
  }

  async deleteAuthStatesByPrefix(prefix) {
    if (!this.pool) return;
    await this.pool.query('DELETE FROM public.library_auth_state WHERE left(state_key,length($1))=$1', [String(prefix)]);
  }

  async consumeRateLimit(key, limit, windowMs) {
    if (!this.pool) throw new Error('Persistent rate limiting requires the Supabase database.');
    const result = await this.pool.query(
      `INSERT INTO public.library_rate_limits (bucket_key,hit_count,window_started_at,expires_at)
       VALUES ($1,1,now(),now()+($3::double precision * interval '1 millisecond'))
       ON CONFLICT (bucket_key) DO UPDATE SET
         hit_count=CASE WHEN public.library_rate_limits.window_started_at <= now()-($3::double precision * interval '1 millisecond') THEN 1 ELSE public.library_rate_limits.hit_count+1 END,
         window_started_at=CASE WHEN public.library_rate_limits.window_started_at <= now()-($3::double precision * interval '1 millisecond') THEN now() ELSE public.library_rate_limits.window_started_at END,
         expires_at=now()+($3::double precision * interval '1 millisecond')
       RETURNING hit_count`,
      [String(key), Number(limit), Number(windowMs)]
    );
    return Number(result.rows[0].hit_count) <= Number(limit);
  }

  async cleanupTransientState() {
    if (!this.pool) return;
    await this.pool.query('DELETE FROM public.library_auth_state WHERE expires_at <= now()');
    await this.pool.query('DELETE FROM public.library_rate_limits WHERE expires_at <= now()');
  }

  async appendAudit(entry) {
    const { at, event, ip, ...detail } = entry || {};
    if (this.pool) {
      await this.pool.query(
        'INSERT INTO public.library_audit_events (created_at,event,ip,detail) VALUES ($1,$2,$3,$4::jsonb)',
        [at || new Date().toISOString(), String(event || 'unknown'), ip || null, JSON.stringify(detail)]
      );
      return;
    }
    const line = JSON.stringify({ at: at || new Date().toISOString(), event: String(event || 'unknown'), ...(ip ? { ip } : {}), ...detail }) + '\n';
    if (fs.existsSync(this.auditFile) && fs.statSync(this.auditFile).size > 5 * 1024 * 1024) {
      const oldFile = this.auditFile.replace(/\.log$/, '.old.log');
      try { fs.rmSync(oldFile, { force: true }); } catch {}
      fs.renameSync(this.auditFile, oldFile);
    }
    fs.appendFileSync(this.auditFile, line, { mode: 0o600 });
  }

  async readAudit(limit = 50) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
    if (this.pool) {
      const result = await this.pool.query(
        'SELECT created_at,event,ip,detail FROM public.library_audit_events ORDER BY created_at DESC,id DESC LIMIT $1',
        [safeLimit]
      );
      return result.rows.map(row => ({ at: new Date(row.created_at).toISOString(), event: row.event, ...(row.ip ? { ip: row.ip } : {}), ...(row.detail || {}) }));
    }
    try {
      return fs.readFileSync(this.auditFile, 'utf8').split('\n').filter(Boolean).slice(-safeLimit)
        .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).reverse();
    } catch { return []; }
  }

  async putBackup(name, content) {
    if (this.pool) {
      await this.pool.query(
        `INSERT INTO public.library_server_backups (name,size_bytes,content,created_at)
         VALUES ($1,$2,$3,now()) ON CONFLICT (name) DO UPDATE
         SET size_bytes=EXCLUDED.size_bytes,content=EXCLUDED.content,created_at=now()`,
        [name, Buffer.byteLength(content), content]
      );
      return;
    }
    const target = path.join(this.backupDir, name);
    const temp = target + '.tmp';
    fs.writeFileSync(temp, content, { mode: 0o600 });
    fs.renameSync(temp, target);
  }

  async listBackups(namePattern) {
    if (this.pool) {
      const result = await this.pool.query('SELECT name,size_bytes,created_at FROM public.library_server_backups ORDER BY name DESC');
      return result.rows.filter(row => namePattern.test(row.name)).map(row => ({
        name: row.name, size: Number(row.size_bytes), createdAt: new Date(row.created_at).toISOString()
      }));
    }
    return fs.readdirSync(this.backupDir).filter(name => namePattern.test(name)).map(name => {
      const stat = fs.statSync(path.join(this.backupDir, name));
      return { name, size: stat.size, createdAt: stat.mtime.toISOString() };
    }).sort((a, b) => b.name.localeCompare(a.name));
  }

  async getBackup(name) {
    if (this.pool) {
      const result = await this.pool.query('SELECT content FROM public.library_server_backups WHERE name=$1', [name]);
      return result.rows[0]?.content ?? null;
    }
    const target = path.join(this.backupDir, name);
    return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  }

  async deleteBackup(name) {
    if (this.pool) {
      await this.pool.query('DELETE FROM public.library_server_backups WHERE name=$1', [name]);
      return;
    }
    try { fs.unlinkSync(path.join(this.backupDir, name)); } catch {}
  }

  async putPhoto(id, mimeType, buffer) {
    if (this.pool) {
      await this.pool.query(
        'INSERT INTO public.library_student_photos (id,mime_type,image_data) VALUES ($1,$2,$3)',
        [id, mimeType, buffer]
      );
      return;
    }
    const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[mimeType];
    if (!ext) throw new Error('Unsupported photo type.');
    fs.writeFileSync(path.join(this.photoDir, id + ext), buffer, { mode: 0o600 });
  }

  async getPhoto(id) {
    if (!/^[a-f0-9]{32}$/.test(String(id))) return null;
    if (this.pool) {
      const result = await this.pool.query('SELECT mime_type,image_data FROM public.library_student_photos WHERE id=$1', [id]);
      const row = result.rows[0];
      return row ? { mime: row.mime_type, buffer: row.image_data } : null;
    }
    for (const [ext, mime] of [['.jpg','image/jpeg'],['.png','image/png'],['.webp','image/webp']]) {
      const file = path.join(this.photoDir, id + ext);
      if (fs.existsSync(file)) return { mime, buffer: fs.readFileSync(file) };
    }
    return null;
  }

  async cleanupPhotos(usedIds, olderThanMs) {
    const ids = [...usedIds].filter(id => /^[a-f0-9]{32}$/.test(id));
    if (this.pool) {
      await this.pool.query(
        `DELETE FROM public.library_student_photos
         WHERE NOT (id = ANY($1::text[]))
         AND created_at < now() - ($2::text || ' milliseconds')::interval`,
        [ids, String(Math.max(0, Math.floor(olderThanMs)))]
      );
      return;
    }
    for (const name of fs.readdirSync(this.photoDir)) {
      const id = name.replace(/\.[a-z]+$/i, '');
      const file = path.join(this.photoDir, name);
      if (!usedIds.has(id) && Date.now() - fs.statSync(file).mtimeMs > olderThanMs) fs.unlinkSync(file);
    }
  }
}

module.exports = { ExtensionStorage };
