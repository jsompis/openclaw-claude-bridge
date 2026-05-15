'use strict';

const assert = require('assert');
const dns = require('dns').promises;
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

async function withMockedNetwork({ lookup, fetchImpl }, fn) {
  const previousFetch = global.fetch;
  const previousLookup = dns.lookup;
  global.fetch = fetchImpl;
  dns.lookup = lookup;
  try {
    return await fn();
  } finally {
    global.fetch = previousFetch;
    dns.lookup = previousLookup;
  }
}

(async () => {
  const previousMax = process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_MAX_BYTES;
  const previousTimeout = process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS;
  process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_MAX_BYTES = '8';
  process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = '1000';

  try {
    const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const large = Buffer.alloc(16, 0x61);
    const { classifyParts, classifyPartsAsync } = freshAttachments();

    let fetchCalls = 0;
    await withMockedNetwork({
      lookup: async hostname => {
        assert.strictEqual(hostname, 'images.example.test');
        return [{ address: '93.184.216.34', family: 4 }];
      },
      fetchImpl: async (input, options) => {
        fetchCalls += 1;
        assert.strictEqual(String(input), 'https://images.example.test/image.png');
        assert.strictEqual(options.redirect, 'manual', 'download must disable automatic redirects');
        assert.ok(options.signal, 'download must preserve AbortController signal');
        return new Response(tinyPng, {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': String(tinyPng.length),
          },
        });
      },
    }, async () => {
      const accepted = await classifyPartsAsync([
        { type: 'text', text: 'hello' },
        { type: 'image_url', image_url: { url: 'https://images.example.test/image.png' } },
      ], 'async-image');
      assert.strictEqual(accepted.text, 'hello');
      assert.strictEqual(accepted.attachments.length, 1, 'async HTTP image should be attached');
      assert.strictEqual(accepted.attachments[0].type, 'image');
      assert.strictEqual(accepted.attachments[0].source.media_type, 'image/png');
      assert.strictEqual(accepted.attachments[0].source.data, tinyPng.toString('base64'));
    });
    assert.strictEqual(fetchCalls, 1, 'expected one fetch for successful download');

    await withMockedNetwork({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async () => new Response(large, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    }, async () => {
      const { result: rejected, warnings } = await withWarnsCaptured(() => classifyPartsAsync([
        { type: 'image_url', image_url: { url: 'https://images.example.test/too-large.bin' } },
      ], 'async-too-large'));
      assert.deepStrictEqual(rejected.attachments, [], 'oversized remote attachment should be skipped');
      assert.ok(rejected.text.includes('download exceeded max bytes'), `expected max-byte skip text, got: ${rejected.text}`);
      assert.ok(warnings.some(w => w.includes('download exceeded max bytes')), `expected max-byte warning, got: ${warnings.join('\n')}`);
    });

    const syncRemote = classifyParts([
      { type: 'image_url', image_url: { url: 'https://images.example.test/image.png' } },
    ], 'sync-remote');
    assert.deepStrictEqual(syncRemote.attachments, [], 'sync classifier should not download remote URLs');
    assert.ok(syncRemote.text.includes('remote downloads require async path'), `expected async-path skip text, got: ${syncRemote.text}`);

    console.log('attachment async download tests passed');
  } finally {
    if (previousMax === undefined) delete process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_MAX_BYTES;
    else process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_MAX_BYTES = previousMax;
    if (previousTimeout === undefined) delete process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS;
    else process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = previousTimeout;
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
