'use strict';

const assert = require('assert');
const { buildClaudeArgs, shouldSkipClaudePermissions } = require('../src/claude');

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

console.log('claude flag tests passed');
