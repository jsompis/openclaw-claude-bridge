'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-bridge-install-env-'));
const envPath = path.join(tmp, '.env');
fs.writeFileSync(envPath, [
  '# comment',
  'export DASHBOARD_PASS="from file"',
  "SINGLE='quoted value'",
  'INLINE=hello # trailing comment',
  'URL=https://example.com/a#fragment',
  'XML="a&b<c>\\"q\\""',
  'EMPTY=',
  'BAD-KEY=ignored',
  '',
].join('\n'));

try {
  const result = spawnSync('bash', [path.join(REPO, 'service', 'install-mac.sh')], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      OPENCLAW_BRIDGE_INSTALL_MAC_PRINT_ENV: '1',
      OPENCLAW_BRIDGE_INSTALL_MAC_ENV_FILE: envPath,
    },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.strictEqual(result.status, 0, `installer env parser failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  const xml = result.stdout;
  assert.ok(xml.includes('<key>DASHBOARD_PASS</key>\n        <string>from file</string>'), xml);
  assert.ok(xml.includes('<key>SINGLE</key>\n        <string>quoted value</string>'), xml);
  assert.ok(xml.includes('<key>INLINE</key>\n        <string>hello</string>'), xml);
  assert.ok(xml.includes('<key>URL</key>\n        <string>https://example.com/a#fragment</string>'), xml);
  assert.ok(xml.includes('<key>XML</key>\n        <string>a&amp;b&lt;c&gt;&quot;q&quot;</string>'), xml);
  assert.ok(xml.includes('<key>EMPTY</key>\n        <string></string>'), xml);
  assert.ok(!xml.includes('BAD-KEY'), xml);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('mac installer env parser tests passed');
