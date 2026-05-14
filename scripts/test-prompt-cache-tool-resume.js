'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');

delete process.env.DASHBOARD_PASS;
process.env.OPENCLAW_BRIDGE_ENV_FILE = path.join(__dirname, '..', '.env.test-missing');

const { app, statusApp, __setRunClaudeForTests } = require('../src/server');

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

function postJson(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
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

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
    }).on('error', reject);
  });
}

async function main() {
  const calls = [];
  __setRunClaudeForTests(async (systemPrompt, promptText, model, onChunk, signal, reasoningEffort, sessionId, isResume, attachmentBlocks) => {
    calls.push({ systemPrompt, promptText, model, reasoningEffort, sessionId, isResume, attachmentBlocks });
    return {
      text: `Long enough assistant response for prompt-cache tool resume coverage ${calls.length}. This text is deliberately distinctive.`,
      usage: {
        input_tokens: 1,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        output_tokens: 1,
        cost_usd: 0,
      },
    };
  });

  const server = await listen(app);
  let statusServer = null;
  try {
    const port = server.address().port;
    const promptCacheKey = `agent:main:subagent:test-tools-resume:${process.pid}:${Date.now()}`;
    const noopTool = {
      type: 'function',
      function: {
        name: 'noop',
        description: 'noop',
        parameters: { type: 'object', properties: {} },
      },
    };
    const base = {
      model: 'claude-opus-4-7',
      stream: false,
      prompt_cache_key: promptCacheKey,
      tools: [noopTool],
    };

    const first = await postJson(port, {
      ...base,
      messages: [{ role: 'user', content: 'first prompt' }],
    });
    assert.strictEqual(first.status, 200, first.body);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].isResume, false, 'first request should start a new CLI session');
    assert.ok(calls[0].sessionId, 'first request should receive a CLI session id');

    const second = await postJson(port, {
      ...base,
      messages: [{ role: 'user', content: 'second prompt' }],
    });
    assert.strictEqual(second.status, 200, second.body);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[1].isResume, true, 'second request should resume via prompt_cache_key channelMap');
    assert.strictEqual(calls[1].sessionId, calls[0].sessionId, 'second request should reuse the first CLI session id');
    assert.match(calls[1].promptText, /second prompt/);

    statusServer = await listen(statusApp);
    const dashboard = await getJson(statusServer.address().port, '/status');
    assert.strictEqual(dashboard.status, 200);
    const expectedChannel = `session:${promptCacheKey}`.slice(0, 40);
    const matchingLog = dashboard.json.log.filter(e => e.channel === expectedChannel && e.routingSource === 'promptCacheKey');
    assert.ok(matchingLog.length >= 2, 'expected both tool requests to be logged as promptCacheKey-routed');
    const expectedRoutingKeyLabel = `promptCacheKey:${promptCacheKey}`.slice(0, 40);
    const matchingChannel = dashboard.json.channels.find(c => c.label === expectedRoutingKeyLabel && c.routingSource === 'promptCacheKey');
    assert.ok(matchingChannel, 'expected channelMap status entry to expose promptCacheKey routing source');

    console.log('prompt_cache_key tools resume test passed');
  } finally {
    __setRunClaudeForTests(null);
    if (statusServer) await close(statusServer);
    await close(server);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
