'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');

delete process.env.DASHBOARD_PASS;
process.env.OPENCLAW_BRIDGE_ENV_FILE = path.join(__dirname, '..', '.env.test-missing');

const { app } = require('../src/server');

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
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  try {
    const base = {
      model: 'claude-opus-4-7',
      stream: false,
      tools: [],
      messages: [{ role: 'user', content: 'memory flush probe' }],
    };
    await request(port, { ...base, prompt_cache_key: 'agent:main:subagent:test-123' });
    const status = await request(port, { ...base, messages: [{ role: 'user', content: 'memory flush probe 2' }] });

    const inbound = {
      role: 'developer',
      content: '## Inbound Context (trusted metadata)\n```json\n{"channel":"cron","chat_type":"direct","account_id":"default"}\n```\n\n# IDENTITY.md\n- **Name:** CronAgent\n',
    };
    await request(port, { ...base, prompt_cache_key: undefined, messages: [inbound, { role: 'user', content: 'memory flush probe 3' }] });
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
    const first = dashboard.log.find(e => e.routingSource === 'promptCacheKey');
    assert.ok(first, 'expected promptCacheKey-routed request in log');
    assert.strictEqual(first.channel, 'session:agent:main:subagent:test-123'.slice(0, 40));
    const inboundEntry = dashboard.log.find(e => e.routingSource === 'inboundContext' && e.agent === 'CronAgent');
    assert.ok(inboundEntry, 'expected inboundContext-routed memflush request in log');
    assert.strictEqual(inboundEntry.channel, 'cron');
    console.log('routing tests passed');
  } finally {
    server.close();
  }
}
main().catch(err => { console.error(err); process.exit(1); });
