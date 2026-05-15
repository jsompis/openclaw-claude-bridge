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

function getJson(port, requestPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${requestPath}`, (res) => {
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
      text: `No-tool routed response ${calls.length}`,
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
    const promptCacheKey = `agent:main:subagent:no-tools-chat:${process.pid}:${Date.now()}`;
    const base = {
      model: 'claude-opus-4-7',
      stream: false,
      prompt_cache_key: promptCacheKey,
      tools: [],
    };

    const first = await postJson(port, {
      ...base,
      messages: [{ role: 'user', content: 'ordinary no-tool chat should route to Claude' }],
    });
    assert.strictEqual(first.status, 200, first.body);
    assert.strictEqual(first.json?.choices?.[0]?.message?.content, 'No-tool routed response 1');
    assert.strictEqual(calls.length, 1, 'ordinary no-tool chat should call Claude handler');
    assert.strictEqual(calls[0].isResume, false, 'first no-tool chat should start a new CLI session');
    assert.match(calls[0].promptText, /ordinary no-tool chat should route to Claude/);

    const second = await postJson(port, {
      ...base,
      messages: [{ role: 'user', content: 'second ordinary no-tool chat should keep routing identity' }],
    });
    assert.strictEqual(second.status, 200, second.body);
    assert.strictEqual(second.json?.choices?.[0]?.message?.content, 'No-tool routed response 2');
    assert.strictEqual(calls.length, 2, 'second no-tool chat should call Claude handler');
    assert.strictEqual(calls[1].isResume, true, 'second no-tool chat should resume by prompt_cache_key');
    assert.strictEqual(calls[1].sessionId, calls[0].sessionId, 'prompt_cache_key routing identity should be preserved');

    statusServer = await listen(statusApp);
    const dashboard = await getJson(statusServer.address().port, '/status');
    assert.strictEqual(dashboard.status, 200);
    const expectedChannel = `session:${promptCacheKey}`.slice(0, 40);
    const matchingLog = dashboard.json.log.filter(e => e.channel === expectedChannel && e.routingSource === 'promptCacheKey');
    assert.ok(matchingLog.length >= 2, 'expected no-tool ordinary chats to be logged under promptCacheKey route');
    assert.ok(matchingLog.every(e => e.resumeMethod !== 'memflush'), 'ordinary no-tool chats must not be marked memflush');

    console.log('no-tool chat routing tests passed');
  } finally {
    __setRunClaudeForTests(null);
    if (statusServer) await close(statusServer);
    await close(server);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
