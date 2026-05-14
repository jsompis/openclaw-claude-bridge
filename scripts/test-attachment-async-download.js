'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');

function freshAttachments() {
  const modulePath = path.resolve(__dirname, '../src/attachments.js');
  delete require.cache[modulePath];
  return require(modulePath);
}

function withWarnsCaptured(fn) {
  const previous = console.warn;
  const warnings = [];
  console.warn = msg => warnings.push(String(msg));
  return Promise.resolve()
    .then(fn)
    .then(result => ({ result, warnings }))
    .finally(() => { console.warn = previous; });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
  });
}

(async () => {
  const previousMax = process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_MAX_BYTES;
  const previousTimeout = process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS;
  process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_MAX_BYTES = '8';
  process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = '1000';

  const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const large = Buffer.alloc(16, 0x61);
  const server = http.createServer((req, res) => {
    if (req.url === '/image.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(tinyPng.length) });
      res.end(tinyPng);
      return;
    }
    if (req.url === '/too-large.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(large);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('missing');
  });

  try {
    const address = await listen(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const { classifyParts, classifyPartsAsync } = freshAttachments();

    const accepted = await classifyPartsAsync([
      { type: 'text', text: 'hello' },
      { type: 'image_url', image_url: { url: `${baseUrl}/image.png` } },
    ], 'async-image');
    assert.strictEqual(accepted.text, 'hello');
    assert.strictEqual(accepted.attachments.length, 1, 'async HTTP image should be attached');
    assert.strictEqual(accepted.attachments[0].type, 'image');
    assert.strictEqual(accepted.attachments[0].source.media_type, 'image/png');
    assert.strictEqual(accepted.attachments[0].source.data, tinyPng.toString('base64'));

    const { result: rejected, warnings } = await withWarnsCaptured(() => classifyPartsAsync([
      { type: 'image_url', image_url: { url: `${baseUrl}/too-large.bin` } },
    ], 'async-too-large'));
    assert.deepStrictEqual(rejected.attachments, [], 'oversized remote attachment should be skipped');
    assert.ok(rejected.text.includes('download exceeded max bytes'), `expected max-byte skip text, got: ${rejected.text}`);
    assert.ok(warnings.some(w => w.includes('download exceeded max bytes')), `expected max-byte warning, got: ${warnings.join('\n')}`);

    const syncRemote = classifyParts([
      { type: 'image_url', image_url: { url: `${baseUrl}/image.png` } },
    ], 'sync-remote');
    assert.deepStrictEqual(syncRemote.attachments, [], 'sync classifier should not download remote URLs');
    assert.ok(syncRemote.text.includes('remote downloads require async path'), `expected async-path skip text, got: ${syncRemote.text}`);

    console.log('attachment async download tests passed');
  } finally {
    await close(server);
    if (previousMax === undefined) delete process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_MAX_BYTES;
    else process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_MAX_BYTES = previousMax;
    if (previousTimeout === undefined) delete process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS;
    else process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = previousTimeout;
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
