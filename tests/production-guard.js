'use strict';

// Verifies production mode cannot use the development fake OTP even when the env flag is set.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJECT = path.resolve(__dirname, '..');
const PORT = Number(process.env.SHARDA_PROD_TEST_PORT || 31982);
const BASE = `http://127.0.0.1:${PORT}`;

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sharda-prod-guard-'));
  for (const file of ['server.js', 'extension-storage.js']) fs.copyFileSync(path.join(PROJECT, file), path.join(temp, file));
  fs.mkdirSync(path.join(temp, 'data'), { recursive: true });
  const server = spawn(process.execPath, ['server.js'], {
    cwd: temp,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production', ADMIN_ID: 'PROD-TEST-ADMIN', ADMIN_PASSWORD: 'ProdTest!Pass1234', ADMIN_EMAIL: 'prod.admin@example.com', OTP_CHANNEL: 'email', DEV_FAKE_OTP: 'true', DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  server.stdout.on('data', chunk => { logs += chunk.toString(); });
  server.stderr.on('data', chunk => { logs += chunk.toString(); });
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(BASE + '/api/health')).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'production-mode test server starts');
    const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminId: 'PROD-TEST-ADMIN', password: 'ProdTest!Pass1234' }) });
    const cookieHeader = login.headers.get('set-cookie') || '';
    assert.equal(login.status, 200, 'production admin login works');
    assert.ok(/HttpOnly/i.test(cookieHeader) && /SameSite=Strict/i.test(cookieHeader) && /Secure/i.test(cookieHeader), 'production session cookie has secure attributes');
    const cookie = cookieHeader.split(';')[0];
    const otp = await fetch(BASE + '/api/auth/change-password/send-otp', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
    assert.equal(otp.status, 503, 'production mode requires real SMTP credentials');
    assert.ok(!logs.includes('[DEV OTP]'), 'development fake OTP is never printed in production');
    console.log('PASS: 3 production security guard checks');
    console.log('  ✓ production server startup');
    console.log('  ✓ Secure/HttpOnly/SameSite session cookie');
    console.log('  ✓ DEV_FAKE_OTP ignored in production');
  } finally {
    server.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error('Production guard tests failed:', error); process.exitCode = 1; });
