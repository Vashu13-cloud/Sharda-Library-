'use strict';

// Sharda Library backend foundation (Node.js built-ins only).
// Secrets belong in .env / hosting environment variables, never in browser code.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { ExtensionStorage } = require('./extension-storage');
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
function readEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !Object.prototype.hasOwnProperty.call(process.env, m[1])) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
readEnvFile();
const Pool = process.env.DATABASE_URL ? require('pg').Pool : null;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'sharda-library.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || ((process.env.PORT || process.env.NODE_ENV === 'production') ? '0.0.0.0' : '127.0.0.1');
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const OTP_TTL_MS = 5 * 60 * 1000;
// OTP_CHANNEL=email (default) sends the OTP to ADMIN_EMAIL through SMTP; OTP_CHANNEL=sms uses MSG91.
const OTP_CHANNEL = String(process.env.OTP_CHANNEL || 'email').trim().toLowerCase() === 'sms' ? 'sms' : 'email';
const OTP_CONTACT_LABEL = OTP_CHANNEL === 'email' ? 'Email address' : 'Mobile number';
const normalizeEmail = value => String(value || '').trim().toLowerCase();
const isEmail = value => value.length <= 254 && /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(value);
const MAX_BODY = 1024 * 1024;
const MAX_DATA_BODY = 25 * 1024 * 1024;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const MAX_BACKUPS = 60;
const BACKUP_NAME_RE = /^sharda-library-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3}-(auto|manual|pre-save|pre-restore)\.json$/;
const sessions = new Map();
const otpAttempts = new Map();
const loginAttempts = new Map();
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000 }) : null;
const extensionStore = new ExtensionStorage({ pool, root: ROOT });
const PUBLIC_FILES = new Set(['index.html', 'app.js', 'style.css', 'sharda-library-logo.jpg', 'sharda-signature.png']);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
const BASE_HEADERS = { ...(IS_PROD ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}), 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' };

function emptyDb() {
  return { version: 1, admin: null, settings: { libraryName: 'Sharda Library', upiId: '' }, students: [], halfVisits: [], bookingRequests: [], seatHistory: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) { const initial = emptyDb(); fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), { mode: 0o600 }); return initial; }
  try { return Object.assign(emptyDb(), JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); }
  catch (e) { console.error('Database file is invalid. Refusing to overwrite it.', e); process.exit(1); }
}
let db = process.env.VERCEL ? emptyDb() : loadDb();
let dbDataVersion = 0;
function persistLocal(snapshot = db) {
  const temp = DB_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  fs.renameSync(temp, DB_FILE);
}
let persistChain = Promise.resolve();
function persist(touch = true) {
  if (touch) db.updatedAt = new Date().toISOString();
  const snapshot = JSON.parse(JSON.stringify(db));
  const run = async () => {
    if (!pool) { persistLocal(snapshot); return; }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO public.library_meta (id, schema_version, data_version, updated_at) VALUES (1, 1, 0, $1) ON CONFLICT (id) DO NOTHING`, [snapshot.updatedAt]);
      const versionRow = await client.query('SELECT data_version FROM public.library_meta WHERE id=1 FOR UPDATE');
      const remoteVersion = Number(versionRow.rows[0]?.data_version || 0);
      if (remoteVersion !== dbDataVersion) {
        const conflict = new Error('Library data changed on another server. Refresh and retry your action.');
        conflict.status = 409;
        throw conflict;
      }
      await client.query('UPDATE public.library_meta SET data_version=data_version+1, updated_at=$1 WHERE id=1', [snapshot.updatedAt]);
      if (snapshot.admin) await client.query(`INSERT INTO public.library_admin (id,password_salt,password_hash,mobile,created_at,password_changed_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET password_salt=EXCLUDED.password_salt,password_hash=EXCLUDED.password_hash,mobile=EXCLUDED.mobile,password_changed_at=EXCLUDED.password_changed_at`, [snapshot.admin.id, snapshot.admin.password.salt, snapshot.admin.password.hash, snapshot.admin.mobile, snapshot.admin.createdAt || snapshot.updatedAt, snapshot.admin.passwordChangedAt || snapshot.updatedAt]);
      const tables = [['library_students', snapshot.students, x => x.id || x.libraryId || x.roll], ['library_half_visits', snapshot.halfVisits, x => x.id], ['library_booking_requests', snapshot.bookingRequests, x => x.bookingId], ['library_seat_history', snapshot.seatHistory, x => x.id || x.recordId]];
      for (const [table, rows, keyOf] of tables) {
        await client.query(`DELETE FROM public.${table}`);
        for (const item of rows) await client.query(`INSERT INTO public.${table} (record_id,payload) VALUES ($1,$2::jsonb)`, [String(keyOf(item) || crypto.randomUUID()), JSON.stringify(item)]);
      }
      await client.query('DELETE FROM public.library_settings');
      for (const [key, value] of Object.entries(snapshot.settings || {})) await client.query('INSERT INTO public.library_settings (setting_key,setting_value) VALUES ($1,$2::jsonb)', [key, JSON.stringify(value)]);
      await client.query('COMMIT');
      dbDataVersion = remoteVersion + 1;
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    finally { client.release(); }
  };
  const result = persistChain.then(run, run);
  persistChain = result.catch(() => {});
  return result;
}
async function commit(touch = true) {
  const before = JSON.parse(JSON.stringify(db));
  try { await persist(touch); }
  catch (error) { db = before; throw error; }
}

async function loadFromSupabase() {
  if (!pool) return;
  const client = await pool.connect();
  let importLocalSnapshot = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const meta = await client.query('SELECT updated_at,data_version FROM public.library_meta WHERE id=1');
    dbDataVersion = Number(meta.rows[0]?.data_version || 0);
    const adminRows = await client.query('SELECT id,password_salt,password_hash,mobile,created_at,password_changed_at FROM public.library_admin ORDER BY created_at LIMIT 1');
    const students = await client.query('SELECT payload FROM public.library_students ORDER BY created_at');
    const half = await client.query('SELECT payload FROM public.library_half_visits ORDER BY created_at');
    const bookings = await client.query('SELECT payload FROM public.library_booking_requests ORDER BY created_at');
    const history = await client.query('SELECT payload FROM public.library_seat_history ORDER BY created_at');
    const settings = await client.query('SELECT setting_key,setting_value FROM public.library_settings');
    const hasRemote = adminRows.rowCount || students.rowCount || half.rowCount || bookings.rowCount || history.rowCount || settings.rowCount;
    if (hasRemote) {
      const a = adminRows.rows[0];
      db.admin = a ? { id:a.id, password:{salt:a.password_salt,hash:a.password_hash}, mobile:a.mobile, createdAt:a.created_at, passwordChangedAt:a.password_changed_at } : null;
      db.students = students.rows.map(r=>r.payload); db.halfVisits = half.rows.map(r=>r.payload); db.bookingRequests = bookings.rows.map(r=>r.payload); db.seatHistory = history.rows.map(r=>r.payload);
      db.settings = Object.fromEntries(settings.rows.map(r=>[r.setting_key,r.setting_value]));
      db.settings = Object.assign({libraryName:'Sharda Library',upiId:''}, db.settings);
      db.updatedAt = meta.rows[0]?.updated_at?.toISOString?.() || meta.rows[0]?.updated_at || new Date().toISOString();
    }
    await client.query('COMMIT');
    if (!hasRemote && !process.env.VERCEL && (db.admin || db.students.length || db.halfVisits.length || db.bookingRequests.length || db.seatHistory.length)) importLocalSnapshot = true;
  } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
  finally { client.release(); }
  if (importLocalSnapshot) {
    await persist();
    console.log('Existing local data imported into the empty Supabase tables.');
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, record) {
  if (!record || !record.salt || !record.hash) return false;
  const actual = crypto.scryptSync(password, record.salt, 64);
  const expected = Buffer.from(record.hash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function cleanMobile(value) { return String(value || '').replace(/\D/g, '').slice(-10); }
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

async function bootstrapAdmin() {
  const needMobile = OTP_CHANNEL === 'sms';
  if (!db.admin && process.env.ADMIN_ID && process.env.ADMIN_PASSWORD && (process.env.ADMIN_MOBILE || !needMobile)) {
    if (String(process.env.ADMIN_PASSWORD).length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
    const mobile = cleanMobile(process.env.ADMIN_MOBILE);
    if (needMobile && mobile.length !== 10) throw new Error('ADMIN_MOBILE must be a valid 10-digit Indian mobile number.');
    if (!needMobile && !isEmail(normalizeEmail(process.env.ADMIN_EMAIL))) throw new Error('ADMIN_EMAIL must be a valid email address (password recovery OTP is sent there).');
    db.admin = { id: String(process.env.ADMIN_ID), password: hashPassword(process.env.ADMIN_PASSWORD), mobile, createdAt: new Date().toISOString(), passwordChangedAt: new Date().toISOString() };
    await commit();
    console.log('Initial admin account created from environment configuration.');
  }
  if (!needMobile && db.admin && !isEmail(normalizeEmail(process.env.ADMIN_EMAIL))) console.warn('WARNING: ADMIN_EMAIL is missing or invalid. Password-recovery OTP emails cannot be sent until it is set.');
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...BASE_HEADERS, ...extraHeaders });
  res.end(JSON.stringify(payload));
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function authStateKey(key) {
  const value = String(key || '');
  const split = value.indexOf(':');
  const kind = split > 0 ? value.slice(0, split) : 'session';
  const token = split > 0 ? value.slice(split + 1) : value;
  return `auth:${kind}:${sha256(token)}`;
}
async function sessionGet(key) {
  return pool ? extensionStore.getAuthState(authStateKey(key)) : sessions.get(key) || null;
}
async function sessionSet(key, record) {
  if (pool) await extensionStore.setAuthState(authStateKey(key), record, record.expiresAt);
  else sessions.set(key, record);
}
async function sessionDelete(key) {
  if (pool) await extensionStore.deleteAuthState(authStateKey(key));
  else sessions.delete(key);
}
async function sessionClearAll() {
  if (pool) {
    for (const prefix of ['auth:session:', 'auth:change:', 'auth:reset:']) await extensionStore.deleteAuthStatesByPrefix(prefix);
  } else sessions.clear();
}
async function sessionFor(req) {
  const token = parseCookies(req).sharda_session;
  const record = token && await sessionGet(token);
  if (!record) return null;
  const now = Date.now();
  if (record.expiresAt < now || (record.lastSeen && now - record.lastSeen > SESSION_IDLE_MS)) { await sessionDelete(token); return null; }
  record.lastSeen = now;
  await sessionSet(token, record);
  return { token, record };
}
async function requireAdmin(req, res) {
  const session = await sessionFor(req);
  if (!session) { sendJson(res, 401, { error: 'Admin authentication required.' }); return null; }
  return session;
}
function readBody(req, maxBytes = MAX_BODY) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') return Promise.resolve(req.body);
    try { return Promise.resolve(typeof req.body === 'string' ? JSON.parse(req.body || '{}') : {}); }
    catch { return Promise.reject(Object.assign(new Error('Invalid JSON body.'), { status: 400 })); }
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    let received = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      received += chunk.length;
      if (received > maxBytes) { tooLarge = true; raw = ''; return; }
      if (!tooLarge) raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (tooLarge) return reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(Object.assign(new Error('Invalid JSON body.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
async function rateLimit(map, key, limit, windowMs) {
  if (pool) return extensionStore.consumeRateLimit(sha256(String(key)), limit, windowMs);
  const now = Date.now(); const old = map.get(key) || { count: 0, start: now };
  if (now - old.start > windowMs) { old.count = 0; old.start = now; }
  old.count += 1; map.set(key, old);
  return old.count <= limit;
}
function cookieHeader(token, maxAge) {
  return `sharda_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${IS_PROD ? '; Secure' : ''}`;
}

// DEV_FAKE_OTP is for local testing only. It is ignored in production and whenever MSG91 is configured.
const DEV_FAKE_OTP = process.env.DEV_FAKE_OTP === 'true' && !IS_PROD && !(process.env.MSG91_AUTH_KEY || process.env.MSG91_TEMPLATE_ID);
const devOtps = new Map();
const maskMobile = mobile => '******' + String(mobile).slice(-4);
async function msg91SendOtp(mobile) {
  if (DEV_FAKE_OTP) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    devOtps.set(mobile, { hash: crypto.createHash('sha256').update(code).digest('hex'), code, expiresAt: Date.now() + OTP_TTL_MS });
    console.log(`[DEV OTP] Code for ${maskMobile(mobile)}: ${code} (valid 5 minutes)`);
    return { type: 'success' };
  }
  const authKey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_TEMPLATE_ID;
  if (!authKey || !templateId) throw new Error('SMS provider is not configured yet.');
  const url = new URL('https://control.msg91.com/api/v5/otp');
  url.searchParams.set('template_id', templateId);
  url.searchParams.set('mobile', '91' + mobile);
  url.searchParams.set('otp_length', '6');
  url.searchParams.set('otp_expiry', '5');
  url.searchParams.set('realTimeResponse', '1');
  const response = await fetch(url, { method: 'POST', headers: { authkey: authKey, 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || (result.type && String(result.type).toLowerCase() === 'error')) throw new Error('OTP provider could not send the message. Check MSG91 configuration.');
  return result;
}
async function msg91ResendOtp(mobile) {
  if (DEV_FAKE_OTP) {
    const entry = devOtps.get(mobile);
    if (!entry || entry.expiresAt < Date.now()) throw new Error('The previous OTP has expired. Request a new OTP.');
    console.log(`[DEV OTP] Resent code for ${maskMobile(mobile)}: ${entry.code} (valid 5 minutes)`);
    return { type: 'success' };
  }
  const authKey = process.env.MSG91_AUTH_KEY;
  if (!authKey) throw new Error('SMS provider is not configured yet.');
  const url = new URL('https://control.msg91.com/api/v5/otp/retry');
  url.searchParams.set('authkey', authKey);
  url.searchParams.set('mobile', '91' + mobile);
  url.searchParams.set('retrytype', 'text');
  const response = await fetch(url, { headers: { authkey: authKey } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || String(result.type || '').toLowerCase() === 'error') throw new Error('OTP provider could not resend the message. Request a new OTP or check MSG91 configuration.');
  return result;
}

async function msg91VerifyOtp(mobile, otp) {
  if (DEV_FAKE_OTP) {
    const entry = devOtps.get(mobile);
    if (!entry || entry.expiresAt < Date.now()) { devOtps.delete(mobile); return false; }
    const good = safeEqual(entry.hash, crypto.createHash('sha256').update(otp).digest('hex'));
    if (good) devOtps.delete(mobile);
    return good;
  }
  const authKey = process.env.MSG91_AUTH_KEY;
  if (!authKey) throw new Error('SMS provider is not configured yet.');
  const url = new URL('https://control.msg91.com/api/v5/otp/verify');
  url.searchParams.set('mobile', '91' + mobile);
  url.searchParams.set('otp', otp);
  const response = await fetch(url, { headers: { authkey: authKey } });
  const result = await response.json().catch(() => ({}));
  return response.ok && String(result.type || result.message || '').toLowerCase().includes('success');
}

// ---- Email OTP (SMTP via nodemailer) ----
// Codes are random 6-digit values, stored only as SHA-256 hashes, valid 5 minutes, max 5 guesses.
// Supabase-backed deployments store challenges durably; the Map is used only for local JSON development.
const DEV_FAKE_EMAIL = process.env.DEV_FAKE_OTP === 'true' && !IS_PROD && !process.env.SMTP_PASS;
const emailOtps = new Map();
const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const maskEmail = email => { const [user, domain] = String(email).split('@'); return user.slice(0, 2) + '***@' + (domain || ''); };
let mailTransport = null;
function getMailTransport() {
  if (mailTransport) return mailTransport;
  const user = process.env.SMTP_USER; const pass = String(process.env.SMTP_PASS || '').replace(/\s/g, '');
  if (!user || !pass) throw new Error('Email provider is not configured yet.');
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465;
  mailTransport = require('nodemailer').createTransport({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port, secure, auth: { user, pass }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
  return mailTransport;
}
async function emailSendOtp(email) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  if (DEV_FAKE_EMAIL) {
    console.log(`[DEV OTP] Code for ${maskEmail(email)}: ${code} (valid 5 minutes)`);
  } else {
    const transport = getMailTransport();
    const from = process.env.SMTP_FROM || `"Sharda Library" <${process.env.SMTP_USER}>`;
    try {
      await transport.sendMail({
        from, to: email, subject: 'Sharda Library - your verification code',
        text: `Your Sharda Library OTP is ${code}. It is valid for 5 minutes. Do not share it with anyone. If you did not request it, you can ignore this email.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:420px"><h2 style="margin:0 0 12px">Sharda Library</h2><p>Your verification code is</p><p style="font-size:30px;letter-spacing:6px;font-weight:bold;margin:8px 0">${code}</p><p>It is valid for 5 minutes. Do not share it with anyone.</p><p style="color:#666;font-size:12px">If you did not request this code, you can ignore this email.</p></div>`
      });
    } catch (error) {
      console.warn('Email OTP send failed:', error.code || error.message);
      throw new Error('OTP email could not be sent. Check the SMTP settings (user, app password, host).');
    }
  }
  const entry = { hash: sha256(code), expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 };
  if (pool) await extensionStore.setAuthState('otp-email:' + sha256(email), entry, entry.expiresAt);
  else emailOtps.set(email, entry);
  return { type: 'success' };
}
async function emailVerifyOtp(email, otp) {
  const key = 'otp-email:' + sha256(email);
  if (pool) return extensionStore.verifyOtpHash(key, sha256(otp), 5);
  const entry = emailOtps.get(email);
  if (!entry || entry.expiresAt < Date.now()) { emailOtps.delete(email); return false; }
  entry.attempts += 1;
  if (entry.attempts > 5) { emailOtps.delete(email); return false; }
  const good = safeEqual(entry.hash, sha256(otp));
  if (good) emailOtps.delete(email);
  return good;
}

// ---- Channel-neutral OTP helpers used by the password routes ----
const adminContact = () => OTP_CHANNEL === 'email' ? normalizeEmail(process.env.ADMIN_EMAIL) : String(db.admin?.mobile || '');
const normalizeContact = value => OTP_CHANNEL === 'email' ? normalizeEmail(value) : cleanMobile(value);
const contactLooksValid = value => OTP_CHANNEL === 'email' ? isEmail(value) : value.length === 10;
const maskContact = value => OTP_CHANNEL === 'email' ? maskEmail(value) : maskMobile(value);
const otpSend = contact => OTP_CHANNEL === 'email' ? emailSendOtp(contact) : msg91SendOtp(contact);
// Email resend issues a fresh code (the previous one stops working); SMS resend repeats the active code.
const otpResend = contact => OTP_CHANNEL === 'email' ? emailSendOtp(contact) : msg91ResendOtp(contact);
const otpVerify = async (contact, otp) => OTP_CHANNEL === 'email' ? emailVerifyOtp(contact, otp) : msg91VerifyOtp(contact, otp);
function contactMatchesAdmin(body) {
  const contact = normalizeContact(body.contact ?? body.email ?? body.mobile);
  const target = adminContact();
  return db.admin && target && contactLooksValid(contact) && safeEqual(contact, target) ? contact : null;
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded.slice(0, 64);
  }
  return req.socket?.remoteAddress || 'unknown';
}

function audit(event, detail = {}, req = null) {
  const entry = { at: new Date().toISOString(), event, ...(req ? { ip: clientIp(req) } : {}), ...(detail || {}) };
  extensionStore.appendAudit(entry).catch(error => console.warn('Audit write failed:', error.message));
}

const readAudit = limit => extensionStore.readAudit(limit).catch(() => []);
const listBackups = () => extensionStore.listBackups(BACKUP_NAME_RE);
let lastBackupAt = 0;

async function createBackup(reason) {
  const stamp = new Date().toISOString().slice(0, 23).replace(/[T:.]/g, '-');
  const name = `sharda-library-${stamp}-${reason}.json`;
  const snapshot = JSON.parse(JSON.stringify({
    version: db.version, settings: db.settings, students: db.students,
    halfVisits: db.halfVisits, bookingRequests: db.bookingRequests,
    seatHistory: db.seatHistory, createdAt: db.createdAt, updatedAt: db.updatedAt
  }));
  // Embed image bytes so a backup can be restored on a different host without broken photo URLs.
  for (const student of snapshot.students) {
    const match = String(student.photo || '').match(/^\/api\/photos\/([a-f0-9]{32})$/);
    if (match) {
      const photo = await extensionStore.getPhoto(match[1]);
      student.photo = photo ? `data:${photo.mime};base64,${photo.buffer.toString('base64')}` : '';
    }
  }
  await extensionStore.putBackup(name, JSON.stringify({ backupReason: reason, ...snapshot }, null, 2));
  lastBackupAt = Date.now();
  for (const old of (await listBackups()).slice(MAX_BACKUPS)) await extensionStore.deleteBackup(old.name);
  return name;
}

async function ensureDailyBackup() {
  try {
    const day = new Date().toISOString().slice(0, 10);
    if (!(await listBackups()).some(item => item.name.startsWith(`sharda-library-${day}`) && item.name.endsWith('-auto.json'))) {
      const name = await createBackup('auto');
      audit('backup.auto', { name });
    }
  } catch (error) { console.warn('Automatic backup failed:', error.message); }
}

function validateStudents(list) {
  const ids = new Set();
  const libraryIds = new Set();
  const seats = new Set();
  for (const student of list) {
    if (!student || typeof student !== 'object' || Array.isArray(student)) return 'A student record is invalid.';
    student.id = String(student.id == null ? '' : student.id);
    if (!student.id || student.id.length > 64) return 'A student record has an invalid id.';
    if (ids.has(student.id)) return 'Two student records share the same internal id.';
    ids.add(student.id);
    const libraryId = String(student.libraryId || student.roll || '').trim().toLowerCase();
    if (libraryId && libraryIds.has(libraryId)) return `Student ID ${libraryId} is used more than once.`;
    if (libraryId) libraryIds.add(libraryId);
    if (typeof student.name !== 'string' || !student.name.trim() || student.name.length > 120) return 'A student record has a missing or invalid name.';
    // Completed/Left is an explicit admin action. An expired-but-not-ended membership
    // remains Active and continues to occupy its seat.
    if (student.membershipStatus !== 'Completed' && student.seat) {
      const seat = String(student.seat).trim().padStart(2, '0');
      student.seat = seat;
      if (!/^\d{2}$/.test(seat) || Number(seat) < 1 || Number(seat) > 100) return `Student ${student.name} has an invalid seat number.`;
      if (seats.has(seat)) return `Seat ${seat} is assigned to more than one active student.`;
      seats.add(seat);
    }
  }
  return null;
}

const istDate = (date = new Date()) => date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
function computeStats() {
  const today = istDate();
  const month = today.slice(0, 7);
  const active = db.students.filter(student => student.membershipStatus !== 'Completed');
  const due = active.filter(student => student.dueDate && student.dueDate <= today);
  const pending = active.filter(student => student.feeStatus === 'Pending' || (student.dueDate && student.dueDate <= today));
  const sum = rows => rows.reduce((total, item) => total + (Number(item.monthlyFee ?? item.fee) || 0), 0);
  const visits = db.halfVisits || [];
  return {
    asOf: today,
    students: { total: db.students.length, active: active.length, completed: db.students.length - active.length },
    seats: { capacity: 100, occupied: active.filter(student => student.seat).length, vacant: 100 - active.filter(student => student.seat).length },
    fees: {
      renewalDue: due.length, pendingCount: pending.length, pendingAmount: sum(pending),
      collectedThisMonth: sum(db.students.filter(student => String(student.lastPaid || '').startsWith(month))) +
        sum(visits.filter(visit => visit.payment === 'Paid' && String(visit.date || '').startsWith(month)) )
    },
    halfTime: { visitsToday: visits.filter(visit => visit.date === today).length, visitsThisMonth: visits.filter(visit => String(visit.date || '').startsWith(month)).length },
    bookings: { pending: (db.bookingRequests || []).filter(booking => booking.status === 'Pending').length },
    lastBackupAt: lastBackupAt ? new Date(lastBackupAt).toISOString() : null
  };
}

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
function detectImageType(buffer) {
  if (buffer.length > 12 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length > 12 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
  if (buffer.length > 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}
async function savePhotoFromDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw new Error('Photo must be a JPG, PNG or WebP image.');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > MAX_PHOTO_BYTES) throw new Error('Photo must be 2 MB or smaller.');
  const actualType = detectImageType(buffer);
  if (!actualType || !PHOTO_TYPES.includes(actualType) || actualType !== match[1]) throw new Error('File content is not a valid image.');
  const id = crypto.randomBytes(16).toString('hex');
  await extensionStore.putPhoto(id, actualType, buffer);
  return `/api/photos/${id}`;
}
async function externalizePhotos(students) {
  let changed = false;
  for (const student of students) {
    if (student && typeof student.photo === 'string' && student.photo.startsWith('data:')) {
      try { student.photo = await savePhotoFromDataUrl(student.photo); }
      catch (error) { console.warn('Skipped invalid photo for student', student.id, error.message); student.photo = ''; }
      changed = true;
    } else if (student && typeof student.photo === 'string' && student.photo && !/^\/api\/photos\/[a-f0-9]{32}$/.test(student.photo)) {
      student.photo = ''; changed = true;
    }
  }
  return changed;
}
async function cleanupOrphanPhotos() {
  try {
    const used = new Set(db.students.map(student => String(student.photo || '').replace('/api/photos/', '')).filter(id => /^[a-f0-9]{32}$/.test(id)));
    await extensionStore.cleanupPhotos(used, 60 * 60 * 1000);
  } catch (error) { console.warn('Photo cleanup skipped:', error.message); }
}

async function handleApi(req, res, url) {
  const ip = clientIp(req);
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host) return sendJson(res, 403, { error: 'Cross-site requests are not allowed.' });
      } catch { return sendJson(res, 403, { error: 'Invalid request origin.' }); }
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/internal/cron/backup') {
    const expected = String(process.env.CRON_SECRET || '');
    const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!expected || !safeEqual(supplied, expected)) return sendJson(res, 401, { error: 'Unauthorized.' });
    const name = await createBackup('auto');
    await extensionStore.cleanupTransientState();
    audit('backup.auto', { name }, req);
    return sendJson(res, 200, { ok: true, name });
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'sharda-library', database: pool ? 'supabase' : 'local-json', storage: extensionStore.kind, adminConfigured: Boolean(db.admin), otpChannel: OTP_CHANNEL });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readBody(req);
    if (!(await rateLimit(loginAttempts, ip, 10, 15 * 60 * 1000))) { audit('login.locked', {}, req); return sendJson(res, 429, { error: 'Too many login attempts. Try again later.' }); }
    if (!db.admin) return sendJson(res, 503, { error: 'Admin account is not configured. Follow the setup guide.' });
    if (!safeEqual(body.adminId, db.admin.id) || !verifyPassword(String(body.password || ''), db.admin.password)) { audit('login.failed', {}, req); return sendJson(res, 401, { error: 'Invalid Admin ID or password.' }); }
    const token = crypto.randomBytes(32).toString('hex');
    await sessionSet(token, { createdAt: Date.now(), lastSeen: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
    audit('login.success', {}, req);
    return sendJson(res, 200, { ok: true, adminId: db.admin.id }, { 'Set-Cookie': cookieHeader(token, SESSION_TTL_MS / 1000) });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const session = await sessionFor(req); if (session) await sessionDelete(session.token);
    audit('logout', {}, req);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) });
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/session') {
    const session = await sessionFor(req);
    return sendJson(res, 200, { authenticated: Boolean(session), adminId: session && db.admin ? db.admin.id : null });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/forgot-password/send-otp') {
    const body = await readBody(req);
    if (!(await rateLimit(otpAttempts, 'forgot-ip:' + ip, 5, 15 * 60 * 1000))) return sendJson(res, 429, { error: 'Too many OTP requests from this network. Try again later.' });
    const contact = contactMatchesAdmin(body);
    if (!contact) return sendJson(res, 400, { error: OTP_CONTACT_LABEL + ' could not be verified.' });
    if (!(await rateLimit(otpAttempts, 'forgot:' + contact, 3, 15 * 60 * 1000))) return sendJson(res, 429, { error: 'OTP resend limit reached. Try again later.' });
    try { await otpSend(contact); audit('password.reset.otp.sent', {}, req); return sendJson(res, 200, { ok: true, channel: OTP_CHANNEL, expiresInSeconds: OTP_TTL_MS / 1000 }); }
    catch (error) { return sendJson(res, 503, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/forgot-password/resend-otp') {
    const body = await readBody(req);
    if (!(await rateLimit(otpAttempts, 'resend-forgot-ip:' + ip, 5, 15 * 60 * 1000))) return sendJson(res, 429, { error: 'Too many OTP resend requests from this network. Try again later.' });
    const contact = contactMatchesAdmin(body);
    if (!contact) return sendJson(res, 400, { error: OTP_CONTACT_LABEL + ' could not be verified.' });
    if (!(await rateLimit(otpAttempts, 'resend-forgot:' + contact, 2, 15 * 60 * 1000))) return sendJson(res, 429, { error: 'OTP resend limit reached. Request a new OTP later.' });
    try { await otpResend(contact); audit('password.reset.otp.resent', {}, req); return sendJson(res, 200, { ok: true, channel: OTP_CHANNEL }); }
    catch (error) { return sendJson(res, 503, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/forgot-password/verify-otp') {
    const body = await readBody(req); const otp = String(body.otp || '').replace(/\D/g, '');
    const contact = contactMatchesAdmin(body);
    if (!contact || !/^\d{6}$/.test(otp)) return sendJson(res, 400, { error: 'Invalid verification details.' });
    if (!(await rateLimit(otpAttempts, 'verify-forgot:' + contact + ':' + ip, 5, 10 * 60 * 1000))) return sendJson(res, 429, { error: 'Too many OTP verification attempts. Request a new OTP later.' });
    try {
      if (!await otpVerify(contact, otp)) return sendJson(res, 400, { error: 'OTP is invalid or expired.' });
      const resetToken = crypto.randomBytes(32).toString('hex');
      await sessionSet('reset:' + resetToken, { expiresAt: Date.now() + 10 * 60 * 1000, purpose: 'password-reset' });
      audit('password.reset.otp.verified', {}, req);
      return sendJson(res, 200, { ok: true, resetToken, expiresInSeconds: 600 });
    } catch (error) { return sendJson(res, 503, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/forgot-password/reset') {
    const body = await readBody(req); const key = 'reset:' + String(body.resetToken || ''); const grant = await sessionGet(key);
    if (!grant || grant.expiresAt < Date.now() || grant.purpose !== 'password-reset') return sendJson(res, 401, { error: 'Password reset verification has expired. Request a new OTP.' });
    const password = String(body.newPassword || '');
    if (password.length < 12) return sendJson(res, 400, { error: 'Password must be at least 12 characters.' });
    if (db.admin && verifyPassword(password, db.admin.password)) return sendJson(res, 400, { error: 'New password must be different from the current password.' });
    db.admin.password = hashPassword(password); db.admin.passwordChangedAt = new Date().toISOString();
    await commit(); await sessionDelete(key); await sessionClearAll(); audit('password.reset', {}, req);
    return sendJson(res, 200, { ok: true, message: 'Password updated. Please sign in again.' }, { 'Set-Cookie': cookieHeader('', 0) });
  }
  // Three-step change flow: send OTP -> verify OTP -> use short-lived session-bound token.
  if (req.method === 'POST' && url.pathname === '/api/auth/change-password/send-otp') {
    const session = await requireAdmin(req, res); if (!session) return;
    const contact = adminContact();
    if (!contact || !contactLooksValid(contact)) return sendJson(res, 503, { error: OTP_CONTACT_LABEL + ' for the admin is not configured yet.' });
    if (!(await rateLimit(otpAttempts, 'change:' + contact, 3, 15 * 60 * 1000))) return sendJson(res, 429, { error: 'OTP resend limit reached. Try again in 15 minutes.' });
    try { await otpSend(contact); audit('password.otp.sent', {}, req); return sendJson(res, 200, { ok: true, channel: OTP_CHANNEL, maskedTarget: maskContact(contact), ...(OTP_CHANNEL === 'sms' ? { maskedMobile: maskContact(contact) } : {}), expiresInSeconds: OTP_TTL_MS / 1000 }); }
    catch (error) { return sendJson(res, 503, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/change-password/resend-otp') {
    const session = await requireAdmin(req, res); if (!session) return;
    const contact = adminContact();
    if (!contact || !contactLooksValid(contact)) return sendJson(res, 503, { error: OTP_CONTACT_LABEL + ' for the admin is not configured yet.' });
    if (!(await rateLimit(otpAttempts, 'resend-change:' + contact, 2, 15 * 60 * 1000))) return sendJson(res, 429, { error: 'OTP resend limit reached. Request a new OTP later.' });
    try { await otpResend(contact); audit('password.otp.resent', {}, req); return sendJson(res, 200, { ok: true, channel: OTP_CHANNEL, maskedTarget: maskContact(contact), ...(OTP_CHANNEL === 'sms' ? { maskedMobile: maskContact(contact) } : {}) }); }
    catch (error) { return sendJson(res, 503, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/change-password/verify-otp') {
    const session = await requireAdmin(req, res); if (!session) return;
    const body = await readBody(req); const otp = String(body.otp || '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(otp)) return sendJson(res, 400, { error: 'Enter the 6-digit OTP.' });
    const contact = adminContact();
    if (!contact) return sendJson(res, 503, { error: OTP_CONTACT_LABEL + ' for the admin is not configured yet.' });
    if (!(await rateLimit(otpAttempts, 'verify-change:' + contact + ':' + ip, 5, 10 * 60 * 1000))) return sendJson(res, 429, { error: 'Too many wrong OTP attempts. Request a new OTP later.' });
    try {
      if (!await otpVerify(contact, otp)) { audit('password.otp.failed', {}, req); return sendJson(res, 400, { error: 'OTP is invalid or expired.' }); }
      const changeToken = crypto.randomBytes(32).toString('hex');
      await sessionSet('change:' + changeToken, { expiresAt: Date.now() + 10 * 60 * 1000, purpose: 'password-change', ownerHash: sha256(session.token) });
      audit('password.otp.verified', {}, req);
      return sendJson(res, 200, { ok: true, changeToken, expiresInSeconds: 600 });
    } catch (error) { return sendJson(res, 503, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/change-password') {
    const session = await requireAdmin(req, res); if (!session) return;
    const body = await readBody(req); const key = 'change:' + String(body.changeToken || ''); const grant = await sessionGet(key);
    if (!grant || grant.expiresAt < Date.now() || grant.purpose !== 'password-change' || grant.ownerHash !== sha256(session.token)) return sendJson(res, 401, { error: 'OTP verification is required first (or it expired). Request a new OTP.' });
    const password = String(body.newPassword || '');
    if (password.length < 12) return sendJson(res, 400, { error: 'New password must be at least 12 characters.' });
    if (verifyPassword(password, db.admin.password)) return sendJson(res, 400, { error: 'New password must be different from the current password.' });
    await sessionDelete(key);
    db.admin.password = hashPassword(password); db.admin.passwordChangedAt = new Date().toISOString();
    await commit(); await sessionClearAll(); audit('password.changed', {}, req);
    return sendJson(res, 200, { ok: true, message: 'Password updated. Please sign in again.' }, { 'Set-Cookie': cookieHeader('', 0) });
  }

  if (req.method === 'GET' && url.pathname === '/api/data') {
    if (!await requireAdmin(req, res)) return;
    const { version, settings, students, halfVisits, bookingRequests, seatHistory, updatedAt } = db;
    return sendJson(res, 200, { version, settings, students, halfVisits, bookingRequests, seatHistory, updatedAt });
  }
  if (req.method === 'PUT' && url.pathname === '/api/data') {
    if (!await requireAdmin(req, res)) return;
    const body = await readBody(req, MAX_DATA_BODY);
    if (body.expectedUpdatedAt && body.expectedUpdatedAt !== db.updatedAt) return sendJson(res, 409, { error: 'Library data changed on another device. Refresh the data before saving again.', updatedAt: db.updatedAt });
    for (const key of ['students', 'halfVisits', 'bookingRequests', 'seatHistory']) {
      if (body[key] !== undefined && !Array.isArray(body[key])) return sendJson(res, 400, { error: `${key} must be an array.` });
    }
    if (body.settings !== undefined && (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings))) return sendJson(res, 400, { error: 'settings must be an object.' });
    if (body.students && body.students.length > 10000) return sendJson(res, 413, { error: 'Too many student records.' });
    if (body.halfVisits && body.halfVisits.length > 50000) return sendJson(res, 413, { error: 'Too many half-time visit records.' });
    if (body.bookingRequests && body.bookingRequests.length > 50000) return sendJson(res, 413, { error: 'Too many booking records.' });
    if (body.students) { const issue = validateStudents(body.students); if (issue) return sendJson(res, 400, { error: issue }); }
    const before = { students: db.students.length, halfVisits: db.halfVisits.length, bookingRequests: db.bookingRequests.length };
    if (Date.now() - lastBackupAt > 15 * 60 * 1000 && (db.students.length || db.halfVisits.length || db.bookingRequests.length || db.seatHistory.length)) {
      try { await createBackup('pre-save'); } catch (error) { console.warn('Pre-save backup skipped:', error.message); }
    }
    if (body.students) { await externalizePhotos(body.students); db.students = body.students; }
    if (body.halfVisits) db.halfVisits = body.halfVisits;
    if (body.bookingRequests) {
      const clientIds = new Set(body.bookingRequests.map(item => item && item.bookingId));
      db.bookingRequests = [...body.bookingRequests.filter(item => item && typeof item === 'object' && item.bookingId), ...db.bookingRequests.filter(item => !clientIds.has(item.bookingId))];
    }
    if (body.seatHistory) db.seatHistory = body.seatHistory;
    if (body.settings) { const cleanSettings = { ...body.settings }; delete cleanSettings.adminUser; delete cleanSettings.adminPass; db.settings = cleanSettings; }
    await commit();
    cleanupOrphanPhotos();
    audit('data.saved', { before, after: { students: db.students.length, halfVisits: db.halfVisits.length, bookingRequests: db.bookingRequests.length } }, req);
    return sendJson(res, 200, { ok: true, updatedAt: db.updatedAt, students: db.students });
  }

  if (req.method === 'POST' && url.pathname === '/api/photos') {
    if (!await requireAdmin(req, res)) return;
    const body = await readBody(req, 4 * 1024 * 1024);
    try { const photoUrl = await savePhotoFromDataUrl(body.dataUrl); audit('photo.uploaded', {}, req); return sendJson(res, 201, { ok: true, url: photoUrl }); }
    catch (error) { return sendJson(res, 400, { error: error.message }); }
  }
  const photoMatch = url.pathname.match(/^\/api\/photos\/([a-f0-9]{32})$/);
  if (photoMatch && ['GET', 'HEAD'].includes(req.method)) {
    if (!await requireAdmin(req, res)) return;
    const photo = await extensionStore.getPhoto(photoMatch[1]);
    if (!photo) return sendJson(res, 404, { error: 'Photo not found.' });
    res.writeHead(200, { 'Content-Type': photo.mime, 'Content-Length': photo.buffer.length, 'Cache-Control': 'private, max-age=3600', ...BASE_HEADERS });
    if (req.method === 'HEAD') return res.end();
    return res.end(photo.buffer);
  }

  if (req.method === 'GET' && url.pathname === '/api/stats') {
    if (!await requireAdmin(req, res)) return;
    return sendJson(res, 200, computeStats());
  }
  if (req.method === 'GET' && url.pathname === '/api/fees/due') {
    if (!await requireAdmin(req, res)) return;
    const today = istDate();
    const list = db.students.filter(student => student.membershipStatus !== 'Completed' && student.dueDate && student.dueDate <= today)
      .map(student => ({ id: student.id, name: student.name, phone: student.phone, seat: student.seat, monthlyFee: student.monthlyFee, dueDate: student.dueDate, daysOverdue: Math.max(0, Math.round((Date.parse(today) - Date.parse(student.dueDate)) / 86400000)) }))
      .sort((a, b) => b.daysOverdue - a.daysOverdue);
    return sendJson(res, 200, { asOf: today, count: list.length, totalDue: list.reduce((total, item) => total + (Number(item.monthlyFee) || 0), 0), students: list });
  }
  if (req.method === 'GET' && url.pathname === '/api/audit') {
    if (!await requireAdmin(req, res)) return;
    return sendJson(res, 200, { entries: await readAudit(Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50))) });
  }
  if (req.method === 'GET' && url.pathname === '/api/backups') {
    if (!await requireAdmin(req, res)) return;
    return sendJson(res, 200, { backups: await listBackups() });
  }
  if (req.method === 'POST' && url.pathname === '/api/backups') {
    if (!await requireAdmin(req, res)) return;
    const name = await createBackup('manual'); audit('backup.manual', { name }, req);
    return sendJson(res, 201, { ok: true, name, backups: await listBackups() });
  }
  const backupMatch = url.pathname.match(/^\/api\/backups\/([^/]+?)(\/restore)?$/);
  if (backupMatch) {
    if (!await requireAdmin(req, res)) return;
    const name = decodeURIComponent(backupMatch[1]);
    const content = BACKUP_NAME_RE.test(name) ? await extensionStore.getBackup(name) : null;
    if (content == null) return sendJson(res, 404, { error: 'Backup not found.' });
    if (req.method === 'GET' && !backupMatch[2]) {
      audit('backup.downloaded', { name }, req);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', ...BASE_HEADERS });
      return res.end(content);
    }
    if (req.method === 'POST' && backupMatch[2]) {
      let snapshot; try { snapshot = JSON.parse(content); } catch { return sendJson(res, 400, { error: 'Backup file is damaged.' }); }
      for (const key of ['students', 'halfVisits', 'bookingRequests', 'seatHistory']) if (!Array.isArray(snapshot[key])) snapshot[key] = [];
      const issue = validateStudents(snapshot.students); if (issue) return sendJson(res, 400, { error: 'Backup contains invalid data: ' + issue });
      const safetyBackup = await createBackup('pre-restore');
      db.students = snapshot.students; db.halfVisits = snapshot.halfVisits; db.bookingRequests = snapshot.bookingRequests; db.seatHistory = snapshot.seatHistory;
      if (snapshot.settings && typeof snapshot.settings === 'object' && !Array.isArray(snapshot.settings)) { db.settings = { ...snapshot.settings }; delete db.settings.adminUser; delete db.settings.adminPass; }
      await externalizePhotos(db.students);
      await commit(); cleanupOrphanPhotos(); audit('backup.restored', { name, safetyBackup }, req);
      return sendJson(res, 200, { ok: true, restored: name, safetyBackup, updatedAt: db.updatedAt });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/booking-requests') {
    const body = await readBody(req);
    const phone = cleanMobile(body.phone);
    if (!(await rateLimit(loginAttempts, 'booking:' + ip, 8, 60 * 60 * 1000))) return sendJson(res, 429, { error: 'Too many booking requests. Try again later.' });
    if (phone.length !== 10 || !String(body.name || '').trim() || !['Full-Day', 'Half-Day', 'Full-Time', 'Half-Time'].includes(String(body.plan || ''))) return sendJson(res, 400, { error: 'Please provide valid booking details.' });
    const year = new Date().getFullYear();
    const prefix = `SHL-REQ-${year}-`;
    const max = db.bookingRequests.reduce((total, item) => { const match = String(item.bookingId || '').match(new RegExp('^SHL-REQ-' + year + '-(\\d+)$')); return match ? Math.max(total, Number(match[1])) : total; }, 0);
    const request = { bookingId: prefix + String(max + 1).padStart(4, '0'), name: String(body.name).trim().slice(0,120), phone, email: String(body.email || '').trim().slice(0,160), course: String(body.course || '').trim().slice(0,120), plan: String(body.plan), shift: String(body.shift || '').slice(0,80), joining: String(body.joining || '').slice(0,20), message: String(body.message || '').trim().slice(0,1000), status: 'Pending', seat: '', reason: '', createdAt: new Date().toISOString() };
    db.bookingRequests.push(request); await commit(false); audit('booking.created', { bookingId: request.bookingId }, req);
    return sendJson(res, 201, { ok: true, bookingId: request.bookingId });
  }
  if (req.method === 'POST' && url.pathname === '/api/booking-requests/approve') {
    if (!await requireAdmin(req, res)) return;
    const body = await readBody(req); const bookingId = String(body.bookingId || '').trim();
    const request = db.bookingRequests.find(item => item.bookingId === bookingId);
    if (!request || request.status !== 'Pending') return sendJson(res, 404, { error: 'Pending booking request not found.' });
    const seat = String(body.seat || '').trim().padStart(2, '0'); const fee = Number(body.monthlyFee);
    if (!/^\d{2}$/.test(seat) || Number(seat) < 1 || Number(seat) > 100 || !Number.isFinite(fee) || fee < 0) return sendJson(res, 400, { error: 'Choose a valid seat and monthly fee.' });
    if (db.students.some(student => student.seat === seat && student.membershipStatus !== 'Completed')) return sendJson(res, 409, { error: 'This seat is already assigned or blocked.' });
    const rollYear = new Date().getFullYear();
    const maxRoll = db.students.reduce((total, student) => { const match = String(student.libraryId || student.roll || '').match(new RegExp('^SL-' + rollYear + '-(\\d+)$')); return match ? Math.max(total, Number(match[1])) : total; }, 0);
    const roll = `SL-${rollYear}-${String(maxRoll + 1).padStart(3, '0')}`;
    const student = { id: crypto.randomUUID(), libraryId: roll, membershipStatus: 'Active', name: request.name, phone: request.phone, roll, course: request.course || '', joining: request.joining || new Date().toISOString().slice(0,10), monthlyFee: fee, seat, feeStatus: 'Pending', dueDate: request.joining || new Date().toISOString().slice(0,10), paidMonth: '', lastPaid: '', membershipPlan: request.plan, preferredShift: request.shift };
    db.students.push(student); request.status = 'Approved'; request.seat = seat; request.studentId = student.id; request.reviewedAt = new Date().toISOString().slice(0,10);
    await commit(); audit('booking.approved', { bookingId, studentId: student.id, seat }, req);
    return sendJson(res, 200, { ok: true, student, bookingRequest: request, updatedAt: db.updatedAt });
  }
  if (req.method === 'POST' && url.pathname === '/api/booking-requests/reject') {
    if (!await requireAdmin(req, res)) return;
    const body = await readBody(req); const bookingId = String(body.bookingId || '').trim();
    const request = db.bookingRequests.find(item => item.bookingId === bookingId);
    if (!request || request.status !== 'Pending') return sendJson(res, 404, { error: 'Pending booking request not found.' });
    request.status = 'Rejected'; request.reason = String(body.reason || '').trim().slice(0,500); request.reviewedAt = new Date().toISOString().slice(0,10);
    await commit(); audit('booking.rejected', { bookingId }, req);
    return sendJson(res, 200, { ok: true, bookingRequest: request, updatedAt: db.updatedAt });
  }
  if (req.method === 'GET' && url.pathname === '/api/booking-status') {
    const bookingId = String(url.searchParams.get('id') || '').trim().toUpperCase();
    const phone = cleanMobile(url.searchParams.get('mobile'));
    if (!(await rateLimit(loginAttempts, 'booking-status:' + ip, 20, 15 * 60 * 1000))) return sendJson(res, 429, { error: 'Too many status checks. Try again later.' });
    const request = db.bookingRequests.find(item => String(item.bookingId).toUpperCase() === bookingId && safeEqual(cleanMobile(item.phone), phone));
    if (!request) return sendJson(res, 404, { error: 'Booking request not found.' });
    return sendJson(res, 200, { bookingId: request.bookingId, status: request.status, seat: request.status === 'Approved' ? request.seat : null, reason: request.status === 'Rejected' ? request.reason : null });
  }
  if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'API endpoint not found.' });
  return false;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
let apiQueue = Promise.resolve();
function serializeApiRequest(task) { const run = apiQueue.then(task, task); apiQueue = run.catch(() => {}); return run; }
async function httpHandler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      const handled = await serializeApiRequest(async () => { if (pool) await loadFromSupabase(); return handleApi(req, res, url); });
      if (handled !== false) return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) return sendJson(res, 405, { error: 'Method not allowed.' });
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length !== 1 || !PUBLIC_FILES.has(segments[0])) return sendJson(res, 404, { error: 'Not found.' });
    const filePath = path.resolve(PUBLIC_DIR, '.' + pathname);
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden.' });
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
      const ext = path.extname(filePath).toLowerCase();
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ['.jpg', '.jpeg', '.png', '.webp', '.ico'].includes(ext) ? 'public, max-age=86400' : 'no-cache', ...BASE_HEADERS };
      if (ext === '.html') headers['Content-Security-Policy'] = CSP;
      if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }
      const compressible = ['.html', '.css', '.js', '.json', '.svg'].includes(ext) && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
      if (compressible) { headers['Content-Encoding'] = 'gzip'; headers['Vary'] = 'Accept-Encoding'; }
      res.writeHead(200, headers);
      const stream = fs.createReadStream(filePath);
      if (compressible) stream.pipe(zlib.createGzip()).pipe(res); else stream.pipe(res);
    });
  } catch (error) { console.error(error); if (!res.headersSent) sendJson(res, error.status || 500, { error: error.status ? error.message : 'Internal server error.' }); }
}
const server = http.createServer(httpHandler);
const ready = (async () => {
  if (process.env.VERCEL && !pool) throw new Error('DATABASE_URL is required on Vercel; local JSON storage is not persistent.');
  await extensionStore.init();
  if (pool) { await loadFromSupabase(); console.log('Supabase database connected.'); }
  await bootstrapAdmin();
  const newestBackup = (await listBackups())[0];
  if (newestBackup) lastBackupAt = Date.parse(newestBackup.createdAt);
  if (!process.env.VERCEL) {
    await ensureDailyBackup();
    setInterval(() => {
      ensureDailyBackup();
      if (pool) extensionStore.cleanupTransientState().catch(error => console.warn('Transient-state cleanup failed:', error.message));
      const now = Date.now();
      for (const [key, value] of sessions) if (value.expiresAt < now) sessions.delete(key);
      for (const [mobile, entry] of devOtps) if (entry.expiresAt < now) devOtps.delete(mobile);
      for (const map of [otpAttempts, loginAttempts]) for (const [key, value] of map) if (now - value.start > 60 * 60 * 1000) map.delete(key);
    }, 60 * 60 * 1000).unref();
  }
})();

async function handler(req, res) {
  try { await ready; await httpHandler(req, res); }
  catch (error) { console.error('Backend initialization failed:', error.message); if (!res.headersSent) sendJson(res, 503, { error: 'Backend is temporarily unavailable. Check server configuration.' }); }
}

if (require.main === module) {
  ready.then(() => server.listen(PORT, HOST, () => console.log(`Sharda Library server running at http://${HOST}:${PORT}`)))
    .catch(error => { console.error('Backend startup failed:', error.message); process.exit(1); });
} else {
  module.exports = handler;
  module.exports.handler = handler;
}
