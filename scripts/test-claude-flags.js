'use strict';

const assert = require('assert');
const {
  DEFAULT_CLAUDE_LIVE_IDLE_MS,
  buildClaudeArgs,
  buildClaudeLiveArgs,
  getClaudeLiveIdleMs,
  shouldSkipClaudePermissions,
  shouldUseClaudeLive,
} = require('../src/claude');

function argsFor(env) {
  return buildClaudeArgs({
    hasAttachments: false,
    model: 'claude-sonnet-4-6',
    isResume: false,
    sessionId: 'test-session',
    systemPrompt: 'test system',
    reasoningEffort: undefined,
  }, env);
}

function hasDangerousFlag(args) {
  return args.includes('--dangerously-skip-permissions');
}

assert.strictEqual(shouldSkipClaudePermissions({}), false, 'unset env should not skip permissions');
assert.strictEqual(hasDangerousFlag(argsFor({})), false, 'default args should not include dangerous flag');
assert.strictEqual(shouldUseClaudeLive({}), false, 'live mode should default off');
assert.strictEqual(getClaudeLiveIdleMs({}), DEFAULT_CLAUDE_LIVE_IDLE_MS, 'live idle should default to 10 minutes');
assert.strictEqual(DEFAULT_CLAUDE_LIVE_IDLE_MS, 600000, 'live idle default should be 600000 ms');

for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
  const env = { OPENCLAW_BRIDGE_CLAUDE_SKIP_PERMISSIONS: value };
  assert.strictEqual(shouldSkipClaudePermissions(env), true, `${value} should enable skip permissions`);
  assert.strictEqual(hasDangerousFlag(argsFor(env)), true, `${value} should add dangerous flag`);
}

for (const value of ['0', 'false', 'FALSE', '', 'no', 'off', 'random']) {
  const env = { OPENCLAW_BRIDGE_CLAUDE_SKIP_PERMISSIONS: value };
  assert.strictEqual(shouldSkipClaudePermissions(env), false, `${value} should not enable skip permissions`);
  assert.strictEqual(hasDangerousFlag(argsFor(env)), false, `${value} should not add dangerous flag`);
}

for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
  const env = { OPENCLAW_BRIDGE_CLAUDE_LIVE: value };
  assert.strictEqual(shouldUseClaudeLive(env), true, `${value} should enable live Claude mode`);
}

for (const value of ['0', 'false', 'FALSE', '', 'no', 'off', 'random']) {
  const env = { OPENCLAW_BRIDGE_CLAUDE_LIVE: value };
  assert.strictEqual(shouldUseClaudeLive(env), false, `${value} should not enable live Claude mode`);
}

assert.strictEqual(getClaudeLiveIdleMs({ OPENCLAW_BRIDGE_CLAUDE_LIVE_IDLE_MS: '12345' }), 12345, 'custom live idle should parse');
assert.strictEqual(getClaudeLiveIdleMs({ OPENCLAW_BRIDGE_CLAUDE_LIVE_IDLE_MS: ' 600000 ' }), 600000, 'live idle should trim whitespace');
for (const value of ['0', '-1', '', 'abc']) {
  assert.strictEqual(getClaudeLiveIdleMs({ OPENCLAW_BRIDGE_CLAUDE_LIVE_IDLE_MS: value }), DEFAULT_CLAUDE_LIVE_IDLE_MS, `${value} should fall back to default live idle`);
}

const liveArgs = buildClaudeLiveArgs({
  model: 'claude-sonnet-4-6',
  isResume: false,
  sessionId: 'test-session',
  systemPrompt: 'test system',
  reasoningEffort: undefined,
}, {});
assert.strictEqual(liveArgs.includes('--input-format'), true, 'live args should use stream-json input');
assert.strictEqual(liveArgs.includes('stream-json'), true, 'live args should include stream-json');
assert.strictEqual(liveArgs.includes('--tools'), true, 'live args must still disable Claude native tools');

console.log('claude flag tests passed');
