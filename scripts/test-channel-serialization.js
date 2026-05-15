'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');

// Keep this test hermetic: do not require a real dashboard password or env file.
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(predicate, label, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function okText(label) {
  return `Long enough assistant response for ${label} serialization coverage. This text is deliberately distinctive.`;
}

async function main() {
  const calls = [];
  const firstGate = deferred();

  __setRunClaudeForTests(async (systemPrompt, promptText, model, onChunk, signal, reasoningEffort, sessionId, isResume, attachmentBlocks) => {
    const call = { systemPrompt, promptText, model, reasoningEffort, sessionId, isResume, attachmentBlocks };
    calls.push(call);
    if (calls.length === 1) {
      await firstGate.promise;
      return {
        text: okText('first request'),
        usage: { input_tokens: 1, cache_creation_tokens: 0, cache_read_tokens: 0, output_tokens: 1, cost_usd: 0 },
      };
    }
    return {
      text: okText(`request ${calls.length}`),
      usage: { input_tokens: 1, cache_creation_tokens: 0, cache_read_tokens: 0, output_tokens: 1, cost_usd: 0 },
    };
  });

  const server = await listen(app);
  try {
    const port = server.address().port;
    const promptCacheKey = `agent:main:subagent:test-channel-serialization:${process.pid}:${Date.now()}`;
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

    const first = postJson(port, {
      ...base,
      messages: [{ role: 'user', content: 'first same-channel prompt' }],
    });
    await waitFor(() => calls.length === 1, 'first Claude call to start');

    const second = postJson(port, {
      ...base,
      messages: [{ role: 'user', content: 'second same-channel prompt' }],
    });

    await new Promise(resolve => setTimeout(resolve, 80));
    assert.strictEqual(calls.length, 1, 'second same-channel request must wait for the first to finish');

    firstGate.resolve();
    const firstResponse = await first;
    assert.strictEqual(firstResponse.status, 200, firstResponse.body);

    const secondResponse = await second;
    assert.strictEqual(secondResponse.status, 200, secondResponse.body);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].isResume, false, 'first request should start a new CLI session');
    assert.strictEqual(calls[1].isResume, true, 'second request should resume only after first stored channelMap');
    assert.strictEqual(calls[1].sessionId, calls[0].sessionId, 'second request should reuse first CLI session id');
    assert.match(calls[1].promptText, /second same-channel prompt/);

    const newResponse = await postJson(port, {
      ...base,
      messages: [
        { role: 'assistant', content: 'New session started' },
        { role: 'user', content: 'fresh prompt after slash-new' },
      ],
    });
    assert.strictEqual(newResponse.status, 200, newResponse.body);
    assert.strictEqual(calls.length, 3);
    assert.strictEqual(calls[2].isResume, false, '/new marker should clear stale channelMap before Claude runs');
    assert.notStrictEqual(calls[2].sessionId, calls[0].sessionId, '/new should allocate a fresh CLI session id');
    assert.match(calls[2].promptText, /fresh prompt after slash-new/);

    console.log('channel serialization tests passed');
  } finally {
    __setRunClaudeForTests(null);
    await close(server);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
