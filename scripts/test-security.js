'use strict';

const assert = require('assert');
const http = require('http');
const { spawnSync } = require('child_process');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const INDEX = path.join(REPO, 'src', 'index.js');

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

(async function testCleanupRequiresAuth() {
  // Use a high port and load the statusApp directly to avoid binding the real ports.
  // Point .env loading at a missing file so this read-only test remains independent
  // of the developer's real repo-root .env.
  delete process.env.DASHBOARD_PASS;
  process.env.OPENCLAW_BRIDGE_ENV_FILE = path.join(REPO, '.env.test-missing');
  const { statusApp } = require(path.join(REPO, 'src', 'server'));
  const server = statusApp.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  try {
    const noAuth = await request(port, 'POST', '/cleanup');
    assert.strictEqual(noAuth.status, 403, `expected 403 for /cleanup without DASHBOARD_PASS, got ${noAuth.status}`);
    const parsed = JSON.parse(noAuth.body || '{}');
    assert.strictEqual(parsed.error, 'dashboard_password_required');
  } finally {
    server.close();
  }
})().then(
  () => console.log('security tests passed'),
  err => { console.error(err); process.exit(1); }
);
