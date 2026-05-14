'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { classifyParts } = require('../src/attachments');

function withAttachmentRoots(value, fn) {
  const previous = process.env.OPENCLAW_BRIDGE_ATTACHMENT_ROOTS;
  if (value === undefined) delete process.env.OPENCLAW_BRIDGE_ATTACHMENT_ROOTS;
  else process.env.OPENCLAW_BRIDGE_ATTACHMENT_ROOTS = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.OPENCLAW_BRIDGE_ATTACHMENT_ROOTS;
    else process.env.OPENCLAW_BRIDGE_ATTACHMENT_ROOTS = previous;
  }
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-bridge-attachments-'));

try {
  withAttachmentRoots(undefined, () => {
    const dataUrl = 'data:image/png;base64,aGVsbG8=';
    const out = classifyParts([{ type: 'image_url', image_url: { url: dataUrl } }], 'allowlist-data');
    assert.strictEqual(out.attachments.length, 1, 'data URL should still be accepted');
    assert.strictEqual(out.attachments[0].type, 'image');
    assert.strictEqual(out.attachments[0].source.media_type, 'image/png');
  });

  const allowedDir = path.join(tmpRoot, 'allowed');
  const evilDir = path.join(tmpRoot, 'allowed-but-evil');
  fs.mkdirSync(allowedDir);
  fs.mkdirSync(evilDir);
  const insideFile = path.join(allowedDir, 'inside.png');
  const outsideFile = path.join(tmpRoot, 'outside.png');
  const evilFile = path.join(evilDir, 'evil.png');
  fs.writeFileSync(insideFile, Buffer.from('inside'));
  fs.writeFileSync(outsideFile, Buffer.from('outside'));
  fs.writeFileSync(evilFile, Buffer.from('evil'));

  withAttachmentRoots(undefined, () => {
    const { result, warnings } = withWarnsCaptured(() => classifyParts([
      { type: 'image_url', image_url: { url: insideFile } },
    ], 'allowlist-none'));
    assert.deepStrictEqual(result.attachments, [], 'absolute path should be rejected when allowlist is unset');
    assert.ok(warnings.some(w => w.includes('local file path rejected (no allowlist)')),
      `expected no-allowlist warning, got: ${warnings.join('\n')}`);
  });

  withAttachmentRoots(allowedDir, () => {
    const out = classifyParts([
      { type: 'image_url', image_url: { url: insideFile } },
    ], 'allowlist-inside');
    assert.strictEqual(out.attachments.length, 1, 'path inside allowlisted root should be accepted');
    assert.strictEqual(out.attachments[0].source.data, Buffer.from('inside').toString('base64'));
  });

  withAttachmentRoots(allowedDir, () => {
    const { result, warnings } = withWarnsCaptured(() => classifyParts([
      { type: 'image_url', image_url: { url: outsideFile } },
    ], 'allowlist-outside'));
    assert.deepStrictEqual(result.attachments, [], 'path outside allowlist should be rejected');
    assert.ok(warnings.some(w => w.includes('local file path rejected (outside allowlist)')),
      `expected outside-allowlist warning, got: ${warnings.join('\n')}`);
  });

  withAttachmentRoots(allowedDir, () => {
    const { result } = withWarnsCaptured(() => classifyParts([
      { type: 'image_url', image_url: { url: evilFile } },
    ], 'allowlist-prefix'));
    assert.deepStrictEqual(result.attachments, [], 'prefix sibling should not be considered under allowlisted root');
  });

  console.log('attachment allowlist tests passed');
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
