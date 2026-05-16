'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { spawnSync } = require('child_process');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const INDEX = path.join(REPO, 'src', 'index.js');
const SRC_DIR = path.join(REPO, 'src') + path.sep;
const TEST_PASS = 'test-dashboard-secret';

function request(port, method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers,
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function basicAuth(password = TEST_PASS) {
  return 'Basic ' + Buffer.from(`admin:${password}`).toString('base64');
}

function clearSourceModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_DIR)) delete require.cache[key];
  }
}

async function withDashboard(pass, fn) {
  clearSourceModules();
  const oldHome = process.env.HOME;
  const oldPass = process.env.DASHBOARD_PASS;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-bridge-security-home-'));

  process.env.HOME = tmpHome;
  if (pass) process.env.DASHBOARD_PASS = pass;
  else delete process.env.DASHBOARD_PASS;

  const { statusApp } = require(path.join(REPO, 'src', 'dashboard-api'));
  const server = statusApp.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;

  try {
    await fn(port);
  } finally {
    await new Promise(resolve => server.close(resolve));
    clearSourceModules();
    process.env.HOME = oldHome;
    if (oldPass === undefined) delete process.env.DASHBOARD_PASS;
    else process.env.DASHBOARD_PASS = oldPass;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

(function testExposedBindWithoutPasswordFailsClosed() {
  const result = spawnSync(process.execPath, [INDEX], {
    env: {
      ...process.env,
      OPENCLAW_BRIDGE_STATUS_BIND: '0.0.0.0',
      DASHBOARD_PASS: '',
      OPENCLAW_BRIDGE_PORT: '0',
      OPENCLAW_BRIDGE_STATUS_PORT: '0',
    },
    timeout: 5000,
  });
  assert.strictEqual(result.status, 1, 'expected non-zero exit when binding non-loopback without DASHBOARD_PASS');
  const stderr = (result.stderr || Buffer.alloc(0)).toString();
  assert.ok(stderr.includes('OPENCLAW_BRIDGE_STATUS_BIND'), `expected stderr to mention STATUS_BIND, got: ${stderr}`);
})();

(async function testCleanupCsrfContract() {
  await withDashboard(null, async (port) => {
    const noPassword = await request(port, 'POST', '/cleanup');
    assert.strictEqual(noPassword.status, 403, `expected 403 for /cleanup without DASHBOARD_PASS, got ${noPassword.status}`);
    const parsed = JSON.parse(noPassword.body || '{}');
    assert.strictEqual(parsed.error, 'dashboard_password_required');
  });

  await withDashboard(TEST_PASS, async (port) => {
    const missingCsrf = await request(port, 'POST', '/cleanup', {
      Authorization: basicAuth(),
    });
    assert.strictEqual(missingCsrf.status, 403, `expected 403 for missing cleanup CSRF header, got ${missingCsrf.status}`);
    const parsed = JSON.parse(missingCsrf.body || '{}');
    assert.strictEqual(parsed.error, 'cleanup_csrf_required');
  });

  await withDashboard(TEST_PASS, async (port) => {
    const crossSite = await request(port, 'POST', '/cleanup', {
      Authorization: basicAuth(),
      'X-OpenClaw-Bridge-CSRF': 'cleanup',
      Origin: 'https://attacker.example',
      'Sec-Fetch-Site': 'cross-site',
    });
    assert.strictEqual(crossSite.status, 403, `expected 403 for cross-site cleanup request, got ${crossSite.status}`);
    const parsed = JSON.parse(crossSite.body || '{}');
    assert.strictEqual(parsed.error, 'cleanup_csrf_rejected');
  });

  await withDashboard(TEST_PASS, async (port) => {
    const allowed = await request(port, 'POST', '/cleanup', {
      Authorization: basicAuth(),
      'X-OpenClaw-Bridge-CSRF': 'cleanup',
    });
    assert.strictEqual(allowed.status, 200, `expected 200 for authenticated cleanup with CSRF header, got ${allowed.status}: ${allowed.body}`);
    const parsed = JSON.parse(allowed.body || '{}');
    assert.strictEqual(typeof parsed.deleted, 'number');
    assert.strictEqual(typeof parsed.remaining, 'number');
  });
})().then(
  () => console.log('security tests passed'),
  err => { console.error(err); process.exit(1); }
);
