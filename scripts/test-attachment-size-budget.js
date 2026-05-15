'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
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
  try {
    const result = fn();
    return { result, warnings };
  } finally {
    console.warn = previous;
  }
}

function assertOversizedSkipped({ result, warnings }, label) {
  assert.deepStrictEqual(result.attachments, [], `${label} should not be attached`);
  assert.ok(result.text.includes('attachment exceeded max bytes'),
    `expected max-byte skip text for ${label}, got: ${result.text}`);
  assert.ok(warnings.some(w => w.includes('attachment exceeded max bytes')),
    `expected max-byte warning for ${label}, got: ${warnings.join('\n')}`);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-bridge-attachment-budget-'));
const envKeys = [
  'OPENCLAW_BRIDGE_ATTACHMENT_MAX_BYTES',
  'OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_MAX_BYTES',
  'OPENCLAW_BRIDGE_ATTACHMENT_ROOTS',
  'OPENCLAW_BRIDGE_STATE_DIR',
];
const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));

try {
  process.env.OPENCLAW_BRIDGE_ATTACHMENT_MAX_BYTES = '8';
  delete process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_MAX_BYTES;
  process.env.OPENCLAW_BRIDGE_ATTACHMENT_ROOTS = tmpRoot;
  process.env.OPENCLAW_BRIDGE_STATE_DIR = path.join(tmpRoot, 'state');

  const underLimitImage = path.join(tmpRoot, 'under.png');
  const overLimitImage = path.join(tmpRoot, 'over.png');
  fs.writeFileSync(underLimitImage, Buffer.from('12345678'));
  fs.writeFileSync(overLimitImage, Buffer.from('123456789'));

  const { classifyParts, ATTACHMENT_MAX_BYTES, DOWNLOAD_MAX_BYTES } = freshAttachments();
  assert.strictEqual(ATTACHMENT_MAX_BYTES, 8, 'unified max should honor OPENCLAW_BRIDGE_ATTACHMENT_MAX_BYTES');
  assert.strictEqual(DOWNLOAD_MAX_BYTES, 8, 'remote download default should share unified attachment max');

  const acceptedLocal = classifyParts([
    { type: 'image_url', image_url: { url: underLimitImage } },
  ], 'budget-local-ok');
  assert.strictEqual(acceptedLocal.attachments.length, 1, 'under-limit local image should be accepted');
  assert.strictEqual(acceptedLocal.attachments[0].source.data, Buffer.from('12345678').toString('base64'));

  assertOversizedSkipped(withWarnsCaptured(() => classifyParts([
    { type: 'image_url', image_url: { url: overLimitImage } },
  ], 'budget-local-over')), 'oversized local file');

  const oversizedDataUrl = `data:image/png;base64,${Buffer.from('123456789').toString('base64')}`;
  assertOversizedSkipped(withWarnsCaptured(() => classifyParts([
    { type: 'image_url', image_url: { url: oversizedDataUrl } },
  ], 'budget-data-over')), 'oversized data URL');

  assertOversizedSkipped(withWarnsCaptured(() => classifyParts([
    { type: 'file', file: { filename: 'notes.txt', file_data: Buffer.from('123456789').toString('base64') } },
  ], 'budget-text-over')), 'oversized inline text attachment');

  const acceptedText = classifyParts([
    { type: 'file', file: { filename: 'notes.txt', file_data: Buffer.from('12345678').toString('base64') } },
  ], 'budget-text-ok');
  assert.deepStrictEqual(acceptedText.attachments, [], 'text attachment should be inlined, not attached as a content block');
  assert.ok(acceptedText.text.includes('[attached file: notes.txt]'), `expected text attachment header, got: ${acceptedText.text}`);
  assert.ok(acceptedText.text.includes('12345678'), `expected under-limit text body, got: ${acceptedText.text}`);

  console.log('attachment size budget tests passed');
} finally {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const modulePath = path.resolve(__dirname, '../src/attachments.js');
  delete require.cache[modulePath];
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
