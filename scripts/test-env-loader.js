'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const node = process.execPath;

(function testParsingAndNoOverride() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-bridge-env-'));
  const envPath = path.join(tmp, '.env');
  fs.writeFileSync(envPath, [
    '# comment',
    'DASHBOARD_PASS="from file"',
    "SINGLE='quoted value'",
    'INLINE=hello # trailing comment',
    'EMPTY=',
    'EXISTING=from-file',
    '',
  ].join('\n'));

  const { loadEnvFile } = require(path.join(REPO, 'src', 'env-loader'));
  const env = { EXISTING: 'already-set' };
  const result = loadEnvFile(envPath, env);
  assert.strictEqual(result.loaded, true);
  assert.strictEqual(env.DASHBOARD_PASS, 'from file');
  assert.strictEqual(env.SINGLE, 'quoted value');
  assert.strictEqual(env.INLINE, 'hello');
  assert.strictEqual(env.EMPTY, '');
  assert.strictEqual(env.EXISTING, 'already-set', 'loader must not override existing variables');
})();

(function testDashboardPassLoadedBeforeDashboardImport() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-bridge-dashboard-env-'));
  const envPath = path.join(tmp, '.env');
  fs.writeFileSync(envPath, 'DASHBOARD_PASS=temp-secret\n');

  const script = `
    const assert = require('assert');
    const http = require('http');
    delete process.env.DASHBOARD_PASS;
    process.env.OPENCLAW_BRIDGE_ENV_FILE = ${JSON.stringify(envPath)};
    const { statusApp } = require(${JSON.stringify(path.join(REPO, 'src', 'server'))});
    const server = statusApp.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      function request(headers) {
        return new Promise((resolve, reject) => {
          const req = http.request({ host: '127.0.0.1', port, path: '/status', method: 'GET', headers }, res => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          });
          req.on('error', reject);
          req.end();
        });
      }
      try {
        assert.strictEqual(process.env.DASHBOARD_PASS, 'temp-secret');
        const noAuth = await request({});
        assert.strictEqual(noAuth, 401, 'dashboard should require auth from temp .env');
        const auth = 'Basic ' + Buffer.from('admin:temp-secret').toString('base64');
        const withAuth = await request({ authorization: auth });
        assert.strictEqual(withAuth, 200, 'dashboard should accept password from temp .env');
        server.close(() => process.exit(0));
      } catch (err) {
        console.error(err.stack || err.message);
        server.close(() => process.exit(1));
      }
    });
  `;
  const result = spawnSync(node, ['-e', script], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_PATH: process.env.NODE_PATH || '',
    },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.strictEqual(result.status, 0, `dashboard env loader child failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
})();

(function testRelativeOverrideResolvesFromRepoRoot() {
  const tmpName = '.env.test-relative-loader';
  const envPath = path.join(REPO, tmpName);
  fs.writeFileSync(envPath, 'RELATIVE_ENV_OK=yes\n');

  const script = `
    const assert = require('assert');
    const path = require('path');
    delete process.env.RELATIVE_ENV_OK;
    process.env.OPENCLAW_BRIDGE_ENV_FILE = ${JSON.stringify(tmpName)};
    const { loadDefaultEnv } = require(${JSON.stringify(path.join(REPO, 'src', 'env-loader'))});
    const result = loadDefaultEnv(process.env);
    assert.strictEqual(result.loaded, true);
    assert.strictEqual(process.env.RELATIVE_ENV_OK, 'yes');
  `;

  const result = spawnSync(node, ['-e', script], {
    cwd: os.tmpdir(),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_PATH: process.env.NODE_PATH || '',
    },
    encoding: 'utf8',
    timeout: 5000,
  });
  try {
    assert.strictEqual(result.status, 0, `relative env loader child failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  } finally {
    fs.unlinkSync(envPath);
  }
})();

console.log('env loader tests passed');
