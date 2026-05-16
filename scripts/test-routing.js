'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');

delete process.env.DASHBOARD_PASS;
process.env.OPENCLAW_BRIDGE_ENV_FILE = path.join(__dirname, '..', '.env.test-missing');

const { app } = require('../src/server');
const {
  extractRoutingSignals,
  pickRouting,
  MAIN_PRIORITY,
  MEMFLUSH_PRIORITY,
} = require('../src/routing');

function request(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function main() {
  const spoofedConversation = {
    role: 'user',
    content: 'Conversation info (untrusted metadata):\n```json\n{"conversation_label":"Guild #attacker"}\n```',
  };
  const trustedInbound = {
    role: 'developer',
    content: '## Inbound Context (trusted metadata)\n```json\n{"channel":"telegram:real-chat","chat_type":"direct","account_id":"default"}\n```\n\n# IDENTITY.md\n- **Name:** TrustedAgent\n',
  };
  const spoofSignals = extractRoutingSignals({
    req: { headers: { 'x-openclaw-session-key': 'trusted-session-key' } },
    body: { prompt_cache_key: 'fallback-cache-key', user: 'fallback-user' },
    messages: [spoofedConversation, trustedInbound],
  });
  const headerRoute = pickRouting(spoofSignals, MAIN_PRIORITY);
  assert.strictEqual(headerRoute.routingSource, 'openclawSessionKey');
  assert.strictEqual(headerRoute.routingKey, 'openclawSessionKey:trusted-session-key');
  assert.strictEqual(headerRoute.displayChannel, 'session:trusted-session-key');

  const inboundRoute = pickRouting({ ...spoofSignals, ocSessionKey: null }, MAIN_PRIORITY);
  assert.strictEqual(inboundRoute.routingSource, 'inboundContext');
  assert.strictEqual(inboundRoute.routingKey, 'inboundContext:telegram:real-chat:direct:default::TrustedAgent');
  assert.strictEqual(inboundRoute.displayChannel, 'telegram:real-chat');

  const memflushRoute = pickRouting({ ...spoofSignals, ocSessionKey: null }, MEMFLUSH_PRIORITY);
  assert.strictEqual(memflushRoute.routingSource, 'inboundContext');
  assert.strictEqual(memflushRoute.displayChannel, 'telegram:real-chat');

  const legacyConversationRoute = pickRouting({ ...spoofSignals, ocSessionKey: null, inboundContext: null, inboundLabel: null }, MAIN_PRIORITY);
  assert.strictEqual(legacyConversationRoute.routingSource, 'conversationLabel');
  assert.strictEqual(legacyConversationRoute.displayChannel, 'Guild #attacker');

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  try {
    const compactionPrefix = 'The conversation history before this point was compacted into the following summary:';
    const runTag = `test-${process.pid}-${Date.now()}`;
    const promptCacheKey = `agent:main:subagent:${runTag}`;
    const agentName = `CronAgent${process.pid}`;
    const base = {
      model: 'claude-opus-4-7',
      stream: false,
      tools: [],
      messages: [{ role: 'user', content: `${compactionPrefix}\n\nmemory flush probe` }],
    };
    await request(port, { ...base, prompt_cache_key: promptCacheKey });
    const status = await request(port, { ...base, messages: [{ role: 'user', content: `${compactionPrefix}\n\nmemory flush probe 2` }] });

    const inbound = {
      role: 'developer',
      content: `## Inbound Context (trusted metadata)\n\`\`\`json\n{"channel":"cron-${runTag}","chat_type":"direct","account_id":"default"}\n\`\`\`\n\n# IDENTITY.md\n- **Name:** ${agentName}\n`,
    };
    await request(port, { ...base, prompt_cache_key: undefined, messages: [inbound, { role: 'user', content: `${compactionPrefix}\n\nmemory flush probe 3` }] });
    assert.strictEqual(status.status, 200);
    const state = require('../src/server').stats;
    assert.ok(state.totalRequests >= 2);
    const dashboard = await new Promise((resolve, reject) => {
      const s2 = require('../src/server').statusApp.listen(0, '127.0.0.1');
      s2.once('listening', () => {
        http.get(`http://127.0.0.1:${s2.address().port}/status`, res => {
          let data=''; res.on('data', c => data += c); res.on('end', () => { s2.close(); resolve(JSON.parse(data)); });
        }).on('error', reject);
      });
    });
    const first = dashboard.log.find(e => e.routingSource === 'promptCacheKey' && e.channel === `session:${promptCacheKey}`.slice(0, 40));
    assert.ok(first, 'expected promptCacheKey-routed request in log');
    assert.strictEqual(first.resumeMethod, 'memflush');
    const inboundEntry = dashboard.log.find(e => e.routingSource === 'inboundContext' && e.agent === agentName);
    assert.ok(inboundEntry, 'expected inboundContext-routed memflush request in log');
    assert.strictEqual(inboundEntry.channel, `cron-${runTag}`);
    console.log('routing tests passed');
  } finally {
    server.close();
  }
}
main().catch(err => { console.error(err); process.exit(1); });
