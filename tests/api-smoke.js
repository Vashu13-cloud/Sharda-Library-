'use strict';

// Isolated API regression suite. Uses a temporary local-file database and test-only OTP.
// It never connects to or modifies the real Supabase project.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJECT = path.resolve(__dirname, '..');
const PORT = Number(process.env.SHARDA_TEST_PORT || 31981);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_ID = 'TEST-ADMIN-FIXED';
const INITIAL_PASSWORD = 'TestOnly!Pass1234';
const NEXT_PASSWORD = 'TestOnly!Pass5678';
const RESET_PASSWORD = 'TestOnly!Pass9012';
const MOBILE = '9876543210';
const EMAIL = 'admin.test@example.com';

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sharda-api-test-'));
  for (const file of ['server.js', 'extension-storage.js']) fs.copyFileSync(path.join(PROJECT, file), path.join(temp, file));
  fs.cpSync(path.join(PROJECT, 'public'), path.join(temp, 'public'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'data'), { recursive: true });

  const server = spawn(process.execPath, ['server.js'], {
    cwd: temp,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', ADMIN_ID, ADMIN_PASSWORD: INITIAL_PASSWORD, ADMIN_EMAIL: EMAIL, OTP_CHANNEL: 'email', DEV_FAKE_OTP: 'true', DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  server.stdout.on('data', chunk => { logs += chunk.toString(); });
  server.stderr.on('data', chunk => { logs += chunk.toString(); });

  const results = [];
  const check = (name, condition) => { assert.ok(condition, name); results.push(name); };
  async function request(method, route, body, cookie, origin) {
    const response = await fetch(BASE + route, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(origin ? { Origin: origin } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const type = response.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, data, headers: response.headers };
  }
  async function waitForServer() {
    for (let i = 0; i < 80; i++) {
      try { const response = await fetch(BASE + '/api/health'); if (response.ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Server did not start. ' + logs);
  }
  async function getDevOtp() {
    for (let i = 0; i < 20; i++) {
      const matches = [...logs.matchAll(/\[DEV OTP\].*?: (\d{6})/g)];
      if (matches.length) return matches[matches.length - 1][1];
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Local test OTP was not printed.');
  }

  try {
    const html = fs.readFileSync(path.join(PROJECT, 'public', 'index.html'), 'utf8');
    const appJs = fs.readFileSync(path.join(PROJECT, 'public', 'app.js'), 'utf8');
    check('admin UI contains resend/change-number and 3-step password controls', ['forgotResendBtn','forgotChangeNumberBtn','changePasswordVerifyOtpForm','changePasswordUpdateForm'].every(id => html.includes(`id="${id}"`)) && appJs.includes('/api/auth/change-password/verify-otp'));
    const cssText = fs.readFileSync(path.join(PROJECT, 'public', 'style.css'), 'utf8');
    check('hidden OTP step forms stay hidden (one step visible at a time)', /form\[hidden\]\s*,[^{]*\{\s*display:\s*none\s*!important/.test(cssText));
    check('Settings page contains reports, security, backup and activity log tools', html.includes('id="page-settings"') && ['serverBackupsTable','auditTable','createServerBackupBtn','refreshAuditBtn','changePasswordSendOtpForm','settingsForm','exportBtn','backupJsonBtn','restoreJsonBtn'].every(id => html.includes(`id="${id}"`)));
    check('Settings is linked from sidebar and dashboard quick actions', html.includes('data-page="settings"') && html.includes('data-go="settings"') && appJs.includes("page === 'settings'"));
    check('Booking Requests remains a separate sidebar page', html.includes('data-page="bookings"') && html.includes('id="page-bookings"'));
    check('Membership Expiry has four clickable colorful categories', ['overdue','today','tomorrow','next-five'].every(name => html.includes(`expiry-card ${name}`)) && ['overdue','today','tomorrow','next5'].every(name => html.includes(`data-expiry-category="${name}"`)));
    check('Overdue membership UI offers explicit renewal and end actions', appJs.includes('data-expiry-renew') && appJs.includes('data-expiry-end') && appJs.includes('function renewExpiredMembership') && appJs.includes('function endExpiredMembership'));
    check('Expires Today also offers renewal/end actions and end action accepts today due date', appJs.includes('const actionable=s.dueDate<=today()') && appJs.includes('!student.dueDate||student.dueDate>today())return;'));
    check('Expired seat cannot be unassigned from the seat modal before renewal/end decision', appJs.includes('Membership renewal is due. This seat stays blocked') && appJs.includes('if(isRenewalDue(s))'));
    check('Main content and sidebar navigation remain independently scrollable', /\.main\{[^}]*overflow-y:auto/s.test(fs.readFileSync(path.join(PROJECT, 'public', 'style.css'), 'utf8')) && /\.sidebar nav\{[^}]*overflow-y:auto/s.test(fs.readFileSync(path.join(PROJECT, 'public', 'style.css'), 'utf8')));
    check('browser JSON backup exports photo bytes', appJs.includes('async function photoToDataUrl') && appJs.includes('Full JSON backup downloaded, including student photos.'));
    await waitForServer();
    const health = await request('GET', '/api/health');
    check('health endpoint', health.status === 200 && health.data.ok === true);
    const homePage = await fetch(BASE + '/');
    const clientScript = await fetch(BASE + '/app.js');
    const privateModule = await fetch(BASE + '/extension-storage.js');
    const privateTest = await fetch(BASE + '/tests/api-smoke.js');
    check('public UI loads with security policy', homePage.status === 200 && (homePage.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'") && clientScript.status === 200);
    check('internal backend/test files are not web-accessible', privateModule.status === 404 && privateTest.status === 404);
    const noAuth = await request('GET', '/api/data');
    const noAuthStats = await request('GET', '/api/stats');
    const noAuthBackups = await request('GET', '/api/backups');
    const noAuthApprove = await request('POST', '/api/booking-requests/approve', { bookingId: 'nope', seat: '01', monthlyFee: 1 });
    check('admin data, stats, backups and booking actions are protected', noAuth.status === 401 && noAuthStats.status === 401 && noAuthBackups.status === 401 && noAuthApprove.status === 401);

    const login = await request('POST', '/api/auth/login', { adminId: ADMIN_ID, password: INITIAL_PASSWORD });
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    check('fixed admin login', login.status === 200 && Boolean(cookie));
    const session = await request('GET', '/api/auth/session', undefined, cookie);
    check('session validation', session.status === 200 && session.data.authenticated === true);

    const crossOrigin = await request('POST', '/api/booking-requests', { name: 'Blocked Origin', phone: MOBILE, plan: 'Full-Day' }, undefined, 'https://untrusted.invalid');
    const initialVersion = await request('GET', '/api/data', undefined, cookie);
    const sameOrigin = await request('POST', '/api/booking-requests', { name: 'Same Origin', phone: MOBILE, plan: 'Full-Day' }, undefined, BASE);
    const afterPublicBooking = await request('GET', '/api/data', undefined, cookie);
    const saveWithOldVersion = await request('PUT', '/api/data', { bookingRequests: [], expectedUpdatedAt: initialVersion.data.updatedAt }, cookie);
    const afterMerge = await request('GET', '/api/data', undefined, cookie);
    check('cross-origin mutation rejected and same-origin accepted', crossOrigin.status === 403 && sameOrigin.status === 201);
    check('public booking does not stale admin version and survives admin data save', afterPublicBooking.data.updatedAt === initialVersion.data.updatedAt && saveWithOldVersion.status === 200 && afterMerge.data.bookingRequests.some(item => item.bookingId === sameOrigin.data.bookingId));

    const duplicateSeats = await request('PUT', '/api/data', {
      students: [{ id: 'dup-a', name: 'Duplicate A', seat: '01', membershipStatus: 'Active' }, { id: 'dup-b', name: 'Duplicate B', seat: '01', membershipStatus: 'Active' }],
      halfVisits: [], bookingRequests: [], seatHistory: [], settings: {}
    }, cookie);
    check('duplicate active seat rejected', duplicateSeats.status === 400);
    const duplicateStudentIds = await request('PUT', '/api/data', {
      students: [{ id: 'roll-a', libraryId: 'SL-2026-001', name: 'Roll A', seat: '01', membershipStatus: 'Active' }, { id: 'roll-b', libraryId: 'SL-2026-001', name: 'Roll B', seat: '02', membershipStatus: 'Active' }],
      halfVisits: [], bookingRequests: [], seatHistory: [], settings: {}
    }, cookie);
    check('duplicate library student ID rejected', duplicateStudentIds.status === 400);

    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/XioAAAAASUVORK5CYII=';
    const dataSave = await request('PUT', '/api/data', {
      students: [{ id: 'expired-seat-holder', name: 'Expired But Not Left', seat: '01', membershipStatus: 'Active', dueDate: '2020-01-01', monthlyFee: 700, feeStatus: 'Pending', photo: png }],
      halfVisits: [], bookingRequests: [], seatHistory: [], settings: { libraryName: 'Sharda Library' }
    }, cookie);
    check('valid data save and photo externalization', dataSave.status === 200 && /^\/api\/photos\/[a-f0-9]{32}$/.test(dataSave.data.students[0].photo));

    const blockedBooking = await request('POST', '/api/booking-requests', { name: 'Seat Block Test', phone: MOBILE, plan: 'Full-Day' });
    const blockedApproval = await request('POST', '/api/booking-requests/approve', { bookingId: blockedBooking.data.bookingId, seat: '01', monthlyFee: 800 }, cookie);
    check('expired active membership keeps seat blocked', blockedApproval.status === 409);

    const freeBooking = await request('POST', '/api/booking-requests', { name: 'New Booking', phone: MOBILE, plan: 'Full-Day' });
    const approved = await request('POST', '/api/booking-requests/approve', { bookingId: freeBooking.data.bookingId, seat: '02', monthlyFee: 800 }, cookie);
    check('server-side booking approval', approved.status === 200 && approved.data.student.seat === '02');
    const rejectBooking = await request('POST', '/api/booking-requests', { name: 'Reject Booking', phone: MOBILE, plan: 'Half-Day' });
    const rejected = await request('POST', '/api/booking-requests/reject', { bookingId: rejectBooking.data.bookingId, reason: 'Test rejection' }, cookie);
    check('server-side booking rejection', rejected.status === 200 && rejected.data.bookingRequest.status === 'Rejected');

    const invalidPhoto = await request('POST', '/api/photos', { dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }, cookie);
    check('unsupported photo type rejected', invalidPhoto.status === 400);

    const stats = await request('GET', '/api/stats', undefined, cookie);
    const fees = await request('GET', '/api/fees/due', undefined, cookie);
    const audit = await request('GET', '/api/audit?limit=20', undefined, cookie);
    check('statistics endpoint', stats.status === 200 && stats.data.seats.occupied === 2);
    check('fees-due endpoint', fees.status === 200 && fees.data.count >= 1);
    check('audit endpoint', audit.status === 200 && Array.isArray(audit.data.entries));

    const photoUrl = dataSave.data.students[0].photo;
    const privatePhoto = await fetch(BASE + photoUrl);
    check('student photo protected without admin session', privatePhoto.status === 401);
    const photo = await fetch(BASE + photoUrl, { headers: { Cookie: cookie } });
    check('student photo available to admin', photo.status === 200 && photo.headers.get('content-type') === 'image/png');

    const backup = await request('POST', '/api/backups', {}, cookie);
    check('manual backup creation', backup.status === 201 && Boolean(backup.data.name));
    const backupList = await request('GET', '/api/backups', undefined, cookie);
    check('backup list', backupList.status === 200 && backupList.data.backups.some(item => item.name === backup.data.name));
    const download = await fetch(BASE + '/api/backups/' + encodeURIComponent(backup.data.name), { headers: { Cookie: cookie } });
    const backupText = await download.text();
    check('backup embeds student photo bytes', download.status === 200 && backupText.includes('data:image/png;base64,'));
    const restored = await request('POST', '/api/backups/' + encodeURIComponent(backup.data.name) + '/restore', {}, cookie);
    check('backup restore with safety snapshot', restored.status === 200 && Boolean(restored.data.safetyBackup));
    const photoAfterRestore = await fetch(BASE + photoUrl, { headers: { Cookie: cookie } });
    check('photo survives backup restore', photoAfterRestore.status === 200);

    const secondLogin = await request('POST', '/api/auth/login', { adminId: ADMIN_ID, password: INITIAL_PASSWORD });
    const secondCookie = secondLogin.headers.get('set-cookie')?.split(';')[0];
    const versionA = await request('GET', '/api/data', undefined, cookie);
    const versionB = await request('GET', '/api/data', undefined, secondCookie);
    const saveA = await request('PUT', '/api/data', { settings: { libraryName: 'Sharda Library A' }, expectedUpdatedAt: versionA.data.updatedAt }, cookie);
    const staleSave = await request('PUT', '/api/data', { settings: { libraryName: 'Sharda Library B' }, expectedUpdatedAt: versionB.data.updatedAt }, secondCookie);
    check('stale multi-device save receives conflict', saveA.status === 200 && staleSave.status === 409);

    const noTokenPasswordChange = await request('POST', '/api/auth/change-password', { newPassword: NEXT_PASSWORD }, cookie);
    check('password cannot change without verified OTP token', noTokenPasswordChange.status === 401);
    const sendOtp = await request('POST', '/api/auth/change-password/send-otp', {}, cookie);
    const resendOtp = await request('POST', '/api/auth/change-password/resend-otp', {}, cookie);
    const otp = await getDevOtp();
    check('change-password OTP send and resend', sendOtp.status === 200 && resendOtp.status === 200 && Boolean(sendOtp.data.maskedTarget));
    const verifyOtp = await request('POST', '/api/auth/change-password/verify-otp', { otp }, cookie);
    check('change-password OTP verification', verifyOtp.status === 200 && Boolean(verifyOtp.data.changeToken));
    const updatePassword = await request('POST', '/api/auth/change-password', { changeToken: verifyOtp.data.changeToken, newPassword: NEXT_PASSWORD }, cookie);
    check('change-password requires verified token', updatePassword.status === 200);
    const oldLogin = await request('POST', '/api/auth/login', { adminId: ADMIN_ID, password: INITIAL_PASSWORD });
    const newLogin = await request('POST', '/api/auth/login', { adminId: ADMIN_ID, password: NEXT_PASSWORD });
    check('old password revoked and new password active', oldLogin.status === 401 && newLogin.status === 200);

    const forgotSend = await request('POST', '/api/auth/forgot-password/send-otp', { contact: EMAIL });
    const forgotResend = await request('POST', '/api/auth/forgot-password/resend-otp', { contact: EMAIL });
    const forgotOtp = await getDevOtp();
    const forgotVerify = await request('POST', '/api/auth/forgot-password/verify-otp', { contact: EMAIL, otp: forgotOtp });
    const forgotReset = await request('POST', '/api/auth/forgot-password/reset', { resetToken: forgotVerify.data.resetToken, newPassword: RESET_PASSWORD });
    const beforeResetLogin = await request('POST', '/api/auth/login', { adminId: ADMIN_ID, password: NEXT_PASSWORD });
    const afterResetLogin = await request('POST', '/api/auth/login', { adminId: ADMIN_ID, password: RESET_PASSWORD });
    check('forgot-password OTP send, resend, verification and reset', forgotSend.status === 200 && forgotResend.status === 200 && forgotVerify.status === 200 && forgotReset.status === 200 && beforeResetLogin.status === 401 && afterResetLogin.status === 200);

    console.log(`PASS: ${results.length} API regression checks`);
    for (const result of results) console.log(`  ✓ ${result}`);
  } finally {
    server.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error('API smoke tests failed:', error); process.exitCode = 1; });
