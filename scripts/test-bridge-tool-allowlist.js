'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');

const { buildToolInstructions, bridgeAllowedToolNames, compactToolSchema, filterBridgeAllowedTools, isBridgeAllowedToolName } = require('../src/tools');

delete process.env.DASHBOARD_PASS;
process.env.OPENCLAW_BRIDGE_ENV_FILE = path.join(__dirname, '..', '.env.test-missing');

const { app, __setRunClaudeForTests } = require('../src/server');

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

function postJson(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (_) {}
        resolve({ status: res.statusCode, body: data, json });
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function functionTool(name, description, parameters = { type: 'object', properties: {} }) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters,
    },
  };
}

async function main() {
  const gatewayTool = functionTool('gateway', 'internal gateway control', {
    type: 'object',
    required: ['action'],
    properties: { action: { type: 'string', enum: ['restart'] } },
  });
  const sessionsSendTool = functionTool('sessions_send', 'internal session send');
  const sessionsSpawnTool = functionTool('sessions_spawn', 'internal session spawn');
  const safeTool = functionTool('read', 'read a file', {
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'Relative file path to read' },
      offset: { type: 'integer', minimum: 1 },
    },
  });
  const tools = [gatewayTool, sessionsSendTool, sessionsSpawnTool, safeTool];

  assert.strictEqual(isBridgeAllowedToolName('gateway'), true);
  assert.strictEqual(isBridgeAllowedToolName('sessions_send'), true);
  assert.strictEqual(isBridgeAllowedToolName('sessions_spawn'), true);
  assert.strictEqual(isBridgeAllowedToolName('read'), true);
  assert.deepStrictEqual(filterBridgeAllowedTools(tools).map(t => t.function.name), ['gateway', 'sessions_send', 'sessions_spawn', 'read']);
  assert.deepStrictEqual(Array.from(bridgeAllowedToolNames(tools)), ['gateway', 'sessions_send', 'sessions_spawn', 'read']);

  const instructions = buildToolInstructions(tools);
  assert.ok(instructions.includes('**gateway**'), 'prompt instructions must reflect OpenClaw-provided gateway tool');
  assert.ok(instructions.includes('**sessions_send**'), 'prompt instructions must reflect OpenClaw-provided sessions_send tool');
  assert.ok(instructions.includes('**sessions_spawn**'), 'prompt instructions must reflect OpenClaw-provided sessions_spawn tool');
  assert.ok(instructions.includes('**read**'), 'prompt instructions must retain safe tool');
  assert.ok(instructions.includes('schema: {"type":"object","required":["path"]'), 'prompt instructions must include compact JSON schema');
  assert.ok(instructions.includes('"path":{"type":"string","description":"Relative file path to read"}'), 'prompt instructions must include parameter fields');
  assert.ok(instructions.includes('"action"'), 'OpenClaw-provided tool schemas should be visible to Claude');
  assert.strictEqual(compactToolSchema(safeTool), '{"type":"object","required":["path"],"properties":{"path":{"type":"string","description":"Relative file path to read"},"offset":{"type":"integer","minimum":1}}}');
  assert.ok(buildToolInstructions([gatewayTool]).includes('**gateway**'), 'bridge must not impose a second hardcoded internal-tool policy');

  const calls = [];
  __setRunClaudeForTests(async (systemPrompt, promptText) => {
    calls.push({ systemPrompt, promptText });
    if (promptText.includes('gateway tool')) {
      return {
        text: '<tool_call>{"name":"gateway","arguments":{"action":"restart"}}</tool_call>',
        usage: { input_tokens: 1, cache_creation_tokens: 0, cache_read_tokens: 0, output_tokens: 1, cost_usd: 0 },
      };
    }
    if (promptText.includes('malformed sessions spawn markup')) {
      return {
        text: 'thinking <tool_call>{"name":"sessions_spawn","arguments":{"prompt":"secret"}}',
        usage: { input_tokens: 1, cache_creation_tokens: 0, cache_read_tokens: 0, output_tokens: 1, cost_usd: 0 },
      };
    }
    return {
      text: '<tool_call>{"name":"read","arguments":{"path":"README.md"}}</tool_call>',
      usage: { input_tokens: 1, cache_creation_tokens: 0, cache_read_tokens: 0, output_tokens: 1, cost_usd: 0 },
    };
  });

  const server = await listen(app);
  try {
    const port = server.address().port;
    const gateway = await postJson(port, {
      model: 'claude-opus-4-7',
      stream: false,
      tools,
      messages: [{ role: 'user', content: 'please emit gateway tool' }],
    });
    assert.strictEqual(gateway.status, 200, gateway.body);
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].systemPrompt.includes('**gateway**'), 'server prompt must reflect gateway tool when OpenClaw provides it');
    assert.ok(calls[0].systemPrompt.includes('**sessions_send**'), 'server prompt must reflect sessions_send when OpenClaw provides it');
    assert.ok(calls[0].systemPrompt.includes('**sessions_spawn**'), 'server prompt must reflect sessions_spawn when OpenClaw provides it');
    assert.ok(calls[0].systemPrompt.includes('**read**'), 'server prompt must keep safe tool');
    assert.ok(calls[0].systemPrompt.includes('schema: {"type":"object","required":["path"]'), 'server prompt must include safe tool schema');
    assert.strictEqual(gateway.json.choices[0].finish_reason, 'tool_calls');
    assert.strictEqual(gateway.json.choices[0].message.tool_calls.length, 1);
    assert.strictEqual(gateway.json.choices[0].message.tool_calls[0].function.name, 'gateway');

    const malformedSessionsSpawn = await postJson(port, {
      model: 'claude-opus-4-7',
      stream: false,
      tools,
      messages: [{ role: 'user', content: 'please emit malformed sessions spawn markup' }],
    });
    assert.strictEqual(malformedSessionsSpawn.status, 200, malformedSessionsSpawn.body);
    assert.strictEqual(malformedSessionsSpawn.json.choices[0].finish_reason, 'tool_calls');
    assert.strictEqual(malformedSessionsSpawn.json.choices[0].message.tool_calls.length, 1);
    assert.strictEqual(malformedSessionsSpawn.json.choices[0].message.tool_calls[0].function.name, 'sessions_spawn');

    const safe = await postJson(port, {
      model: 'claude-opus-4-7',
      stream: false,
      tools,
      messages: [{ role: 'user', content: 'please emit safe tool' }],
    });
    assert.strictEqual(safe.status, 200, safe.body);
    assert.strictEqual(calls.length, 3);
    assert.strictEqual(safe.json.choices[0].finish_reason, 'tool_calls');
    assert.strictEqual(safe.json.choices[0].message.tool_calls.length, 1);
    assert.strictEqual(safe.json.choices[0].message.tool_calls[0].function.name, 'read');
  } finally {
    __setRunClaudeForTests(null);
    await close(server);
  }

  console.log('bridge tool allowlist tests passed');
}

main().catch(err => { console.error(err); process.exit(1); });
