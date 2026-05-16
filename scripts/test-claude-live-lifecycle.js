'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-live-lifecycle-'));
const fakeClaude = path.join(tmpDir, 'fake-claude.js');

fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
'use strict';
const readline = require('readline');

const mode = process.env.FAKE_CLAUDE_MODE || 'stay';
if (mode === 'close-before-result') {
  console.error('fake close before result');
  process.exit(42);
}

let count = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', () => {
  count += 1;
  process.stdout.write(JSON.stringify({
    type: 'result',
    result: 'fake live result pid=' + process.pid + ' count=' + count,
    usage: { input_tokens: 1, output_tokens: 1 },
    total_cost_usd: 0,
  }) + '\\n');
  if (mode === 'exit-after-result') process.exit(0);
});

setInterval(() => {}, 1000);
`, { mode: 0o755 });

process.env.CLAUDE_BIN = fakeClaude;
process.env.OPENCLAW_BRIDGE_CLAUDE_LIVE = '1';
process.env.OPENCLAW_BRIDGE_CLAUDE_LIVE_IDLE_MS = '80';

delete process.env.DASHBOARD_PASS;
process.env.OPENCLAW_BRIDGE_ENV_FILE = path.join(REPO_ROOT, '.env.test-missing');

const { runClaude, getLiveProcessInfo } = require('../src/claude');
const { statusApp } = require('../src/dashboard-api');

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, timeoutMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await wait(10);
  }
  throw new Error(`Timed out waiting for ${label}; live=${JSON.stringify(getLiveProcessInfo())}`);
}

function listen(expressApp) {
  return new Promise((resolve) => {
    const server = expressApp.listen(0, '127.0.0.1');
    server.once('listening', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}

function getJson(port, route) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data), body: data });
        } catch (err) {
          reject(new Error(`Failed to parse JSON status=${res.statusCode}: ${data || err.message}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function runFake(mode, sessionId) {
  process.env.FAKE_CLAUDE_MODE = mode;
  return runClaude('system prompt', 'hello from live lifecycle test', 'claude-opus-4-7', () => {}, undefined, undefined, sessionId, false, []);
}

async function assertLiveCount(count, label) {
  const info = getLiveProcessInfo();
  assert.strictEqual(info.count, count, `${label}: ${JSON.stringify(info)}`);
  return info;
}

function assertSpawnErrorCleanup() {
  const missingBin = path.join(tmpDir, 'missing-claude-bin');
  const source = `
process.env.CLAUDE_BIN = ${JSON.stringify(missingBin)};
process.env.OPENCLAW_BRIDGE_CLAUDE_LIVE = '1';
process.env.OPENCLAW_BRIDGE_CLAUDE_LIVE_IDLE_MS = '80';
const { runClaude, getLiveProcessInfo } = require(${JSON.stringify(path.join(REPO_ROOT, 'src/claude'))});
runClaude('sys', 'prompt', 'claude-opus-4-7', () => {}, undefined, undefined, 'live-spawn-error-session', false, [])
  .then(() => { console.error('unexpected success'); process.exit(2); })
  .catch((err) => {
    console.log(JSON.stringify({ message: err.message, live: getLiveProcessInfo() }));
  });
setTimeout(() => {
  console.error('timed out waiting for spawn error');
  process.exit(3);
}, 1000).unref();
`;
  const result = spawnSync(process.execPath, ['-e', source], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  const payload = JSON.parse(lines[lines.length - 1]);
  assert.match(payload.message, /Failed to spawn Claude live process/);
  assert.strictEqual(payload.live.count, 0, 'spawn error must not leave stale live process state');
}

async function main() {
  await assertLiveCount(0, 'initial live process state');

  const server = await listen(statusApp);
  try {
    const statusSession = 'live-status-session';
    const first = await runFake('stay', statusSession);
    assert.match(first.text, /fake live result/);

    const info = await assertLiveCount(1, 'live process should be reflected after successful request');
    assert.strictEqual(info.processes[0].sessionId, statusSession.slice(0, 8));
    assert.strictEqual(info.processes[0].active, false);
    assert.strictEqual(info.processes[0].closed, false);

    const status = await getJson(server.address().port, '/status');
    assert.strictEqual(status.status, 200, status.body);
    assert.strictEqual(status.json.liveProcesses.count, 1, 'dashboard status should expose live process count');
    assert.strictEqual(status.json.liveProcesses.processes[0].sessionId, statusSession.slice(0, 8));
  } finally {
    await close(server);
  }

  await waitFor(() => getLiveProcessInfo().count === 0, 'idle live process cleanup');
  await assertLiveCount(0, 'idle shutdown should clear live process map');

  const exitSession = 'live-exit-session';
  const exitResult = await runFake('exit-after-result', exitSession);
  assert.match(exitResult.text, /fake live result/);
  await waitFor(() => getLiveProcessInfo().count === 0, 'natural child close cleanup');
  await assertLiveCount(0, 'natural close should clear live process map');

  const errorSession = 'live-error-session';
  await assert.rejects(
    () => runFake('close-before-result', errorSession),
    /Claude live process exited with code 42: fake close before result/,
  );
  await waitFor(() => getLiveProcessInfo().count === 0, 'non-zero child close cleanup');

  const retryResult = await runFake('exit-after-result', errorSession);
  assert.match(retryResult.text, /fake live result/);
  await waitFor(() => getLiveProcessInfo().count === 0, 'same-session respawn after failure cleanup');

  assertSpawnErrorCleanup();

  console.log('claude live lifecycle tests passed');
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });
