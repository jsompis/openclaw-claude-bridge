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

async function assertSkippedBySsrf(classifyPartsAsync, url, message) {
  let fetchCalled = false;
  await withMockedNetwork({
    lookup: async () => { throw new Error('DNS should not be needed for blocked literal/metadata host'); },
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('fetch should not be called for blocked URL');
    },
  }, async () => {
    const { result, warnings } = await withWarnsCaptured(() => classifyPartsAsync([
      { type: 'image_url', image_url: { url } },
    ], 'ssrf-blocked'));
    assert.deepStrictEqual(result.attachments, [], message);
    assert.ok(result.text.includes('remote attachment URL blocked by SSRF policy'), `expected SSRF skip text for ${url}, got: ${result.text}`);
    assert.ok(warnings.some(w => w.includes('remote attachment URL blocked by SSRF policy')), `expected SSRF warning for ${url}, got: ${warnings.join('\n')}`);
  });
  assert.strictEqual(fetchCalled, false, `fetch must not be called for ${url}`);
}

(async () => {
  const { classifyPartsAsync } = freshAttachments();

  for (const url of [
    'http://localhost/image.png',
    'http://127.0.0.1/image.png',
    'http://2130706433/image.png',
    'http://10.0.0.5/image.png',
    'http://172.16.0.5/image.png',
    'http://192.168.1.5/image.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://0.0.0.0/image.png',
    'http://224.0.0.1/image.png',
    'http://240.0.0.1/image.png',
    'http://[::1]/image.png',
    'http://[fe80::1]/image.png',
    'http://[fc00::1]/image.png',
    'http://[ff02::1]/image.png',
    'http://[::ffff:127.0.0.1]/image.png',
    'http://metadata.google.internal/computeMetadata/v1/',
    'https://user:pass@example.com/image.png',
    'http://printer.local/image.png',
    'http://service.internal/image.png',
    'http://router.lan/image.png',
  ]) {
    await assertSkippedBySsrf(classifyPartsAsync, url, `blocked URL should be skipped: ${url}`);
  }

  let fetchCalled = false;
  await withMockedNetwork({
    lookup: async hostname => {
      assert.strictEqual(hostname, 'public.example.test');
      return [{ address: '10.1.2.3', family: 4 }];
    },
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('fetch should not be called after private DNS resolution');
    },
  }, async () => {
    const { result, warnings } = await withWarnsCaptured(() => classifyPartsAsync([
      { type: 'image_url', image_url: { url: 'https://public.example.test/image.png' } },
    ], 'ssrf-dns'));
    assert.deepStrictEqual(result.attachments, [], 'hostname resolving to private IP should be skipped');
    assert.ok(result.text.includes('resolved to blocked address 10.1.2.3'), `expected DNS block text, got: ${result.text}`);
    assert.ok(warnings.some(w => w.includes('resolved to blocked address 10.1.2.3')), `expected DNS block warning, got: ${warnings.join('\n')}`);
  });
  assert.strictEqual(fetchCalled, false, 'fetch must not run when DNS resolves to a blocked address');

  let fetchCalls = 0;
  await withMockedNetwork({
    lookup: async hostname => {
      assert.strictEqual(hostname, 'public.example.test');
      return [{ address: '93.184.216.34', family: 4 }];
    },
    fetchImpl: async (input, options) => {
      fetchCalls += 1;
      assert.strictEqual(String(input), 'https://public.example.test/redirect.png');
      assert.strictEqual(options.redirect, 'manual', 'redirect validation requires manual fetch redirects');
      return new Response('', {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      });
    },
  }, async () => {
    const { result, warnings } = await withWarnsCaptured(() => classifyPartsAsync([
      { type: 'image_url', image_url: { url: 'https://public.example.test/redirect.png' } },
    ], 'ssrf-redirect'));
    assert.deepStrictEqual(result.attachments, [], 'redirect to metadata host should be skipped');
    assert.ok(result.text.includes('blocked address 169.254.169.254'), `expected redirect block text, got: ${result.text}`);
    assert.ok(warnings.some(w => w.includes('blocked address 169.254.169.254')), `expected redirect block warning, got: ${warnings.join('\n')}`);
  });
  assert.strictEqual(fetchCalls, 1, 'fetch must stop before following unsafe redirect target');

  console.log('attachment SSRF tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
