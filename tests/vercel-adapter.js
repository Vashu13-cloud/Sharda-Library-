'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sharda-vercel-adapter-'));
try {
  fs.mkdirSync(path.join(temp, 'api'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'data'), { recursive: true });
  for (const file of ['server.js', 'extension-storage.js']) fs.copyFileSync(path.join(root, file), path.join(temp, file));
  fs.copyFileSync(path.join(root, 'api', '[...path].js'), path.join(temp, 'api', '[...path].js'));
  const probe = `
    const assert = require('node:assert/strict');
    const handler = require('./api/[...path].js');
    assert.equal(typeof handler, 'function');
    const req = { method: 'GET', url: '/api/health', headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' } };
    const res = { headersSent: false, writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; }, end(body) { this.body = body; console.log(JSON.stringify({ statusCode: this.statusCode, body: this.body })); } };
    handler(req, res);
  `;
  const result = spawnSync(process.execPath, ['-e', probe], {
    cwd: temp,
    env: { ...process.env, DATABASE_URL: '', VERCEL: '', NODE_ENV: 'test', ADMIN_ID: '', ADMIN_PASSWORD: '', ADMIN_EMAIL: '' },
    encoding: 'utf8',
    timeout: 15000
  });
  const output = (result.stdout || '').trim().split('\n').filter(Boolean).pop();
  assert.equal(result.status, 0, result.stderr || 'Vercel adapter probe failed');
  const response = JSON.parse(output);
  assert.equal(response.statusCode, 200);
  const health = JSON.parse(response.body);
  assert.equal(health.ok, true);
  assert.equal(health.service, 'sharda-library');
  const noDbProbe = `
    const handler = require('./api/[...path].js');
    const req = { method: 'GET', url: '/api/health', headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' } };
    const res = { headersSent: false, writeHead(status, headers) { this.statusCode = status; this.headersSent = true; }, end(body) { console.log(JSON.stringify({ statusCode: this.statusCode, body })); } };
    handler(req, res);
  `;
  const noDb = spawnSync(process.execPath, ['-e', noDbProbe], {
    cwd: temp,
    env: { ...process.env, DATABASE_URL: '', VERCEL: '1', NODE_ENV: 'production' },
    encoding: 'utf8',
    timeout: 15000
  });
  const noDbResponse = JSON.parse((noDb.stdout || '').trim().split('\n').filter(Boolean).pop());
  assert.equal(noDb.status, 0, noDb.stderr || 'Vercel no-database guard probe failed');
  assert.equal(noDbResponse.statusCode, 503, 'Vercel must fail closed when DATABASE_URL is missing');
  assert.match(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), /if \(require\.main === module\)[\s\S]*?server\.listen/);
  const vercelConfig = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.ok(vercelConfig.crons.some(job => job.path === '/api/internal/cron/backup'));
  assert.ok(vercelConfig.headers.some(rule => rule.headers.some(header => header.key === 'Content-Security-Policy')));
  const publicDir = path.join(root, 'public');
  for (const file of ['index.html', 'app.js', 'style.css', 'sharda-library-logo.jpg', 'sharda-signature.png']) assert.ok(fs.statSync(path.join(publicDir, file)).isFile(), `Missing Vercel static asset: ${file}`);
  assert.equal(fs.existsSync(path.join(root, 'app.js')), false, 'Browser app must not remain at project root where it can be misdetected as a server entrypoint');
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(html, /src=\"app\.js\"/);
  assert.match(html, /href=\"style\.css\"/);
  console.log('PASS: Vercel catch-all adapter, no-local-storage guard and daily backup cron configuration');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
