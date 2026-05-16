'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');

const { buildToolInstructions, compactToolSchema, stripUpstreamToolingSection } = require('../src/tools');

delete process.env.DASHBOARD_PASS;
process.env.OPENCLAW_BRIDGE_ENV_FILE = path.join(__dirname, '..', '.env.test-missing');

const { app, __setRunClaudeForTests } = require('../src/server');

function functionTool(name, description, parameters = { type: 'object', properties: {} }) {
  return { type: 'function', function: { name, description, parameters } };
}

function listen(expressApp) {
  return new Promise((resolve) => {
    const server = expressApp.listen(0, '127.0.0.1');
    server.once('listening', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
}

function postJson(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function main() {
  const upstream = [
    '# Agent',
    '',
    'keep this intro',
    '',
    '## Tooling',
    'Tool availability (filtered by policy):',
    '- read: verbose upstream duplicate',
    '- sessions_spawn: verbose upstream duplicate',
    '',
    '## Runtime',
    'keep runtime block',
  ].join('\n');
  const stripped = stripUpstreamToolingSection(upstream);
  assert.ok(stripped.includes('keep this intro'));
  assert.ok(stripped.includes('## Runtime'));
  assert.ok(!stripped.includes('verbose upstream duplicate'));

  const tool = functionTool('read', 'A '.repeat(200), {
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'drop this long description' },
      mode: { type: 'string', enum: ['a', 'b', 'c'] },
    },
  });
  const schema = compactToolSchema(tool);
  assert.ok(schema.length <= 900);
  assert.ok(!schema.includes('drop this long description'));
  const instructions = buildToolInstructions([tool]);
  assert.ok(instructions.includes('read'));
  assert.ok(!instructions.includes('```'));
  assert.ok(!instructions.includes('drop this long description'));

  const captured = [];
  __setRunClaudeForTests(async (systemPrompt) => {
    captured.push(systemPrompt);
    return { text: 'ok', usage: { input_tokens: 1, cache_creation_tokens: 0, cache_read_tokens: 0, output_tokens: 1, cost_usd: 0 } };
  });

  const server = await listen(app);
  try {
    const port = server.address().port;
    const response = await postJson(port, {
      model: 'claude-opus-4-7',
      stream: false,
      tools: [tool],
      messages: [
        { role: 'system', content: upstream },
        { role: 'user', content: 'hello' },
      ],
    });
    assert.strictEqual(response.status, 200, response.body);
    assert.strictEqual(captured.length, 1);
    assert.ok(captured[0].includes('keep this intro'));
    assert.ok(captured[0].includes('## Runtime'));
    assert.ok(!captured[0].includes('verbose upstream duplicate'));
    assert.ok(captured[0].includes('## Bridge Tool Calling Protocol'));
  } finally {
    __setRunClaudeForTests(null);
    await close(server);
  }

  console.log('system prompt size tests passed');
}

main().catch(err => { console.error(err); process.exit(1); });
