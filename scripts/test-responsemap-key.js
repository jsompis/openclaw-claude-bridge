'use strict';

const assert = require('node:assert/strict');

const { contentKey } = require('../src/state-store');

assert.equal(contentKey('NO_REPLY'), null);
assert.equal(contentKey('HEARTBEAT_OK'), null);
assert.equal(contentKey('  NO_REPLY  '), null);
assert.equal(contentKey('[DONE]'), null);
assert.equal(contentKey('short answer'), null);
assert.equal(contentKey('   '), null);
assert.equal(contentKey(null), null);
assert.equal(contentKey('🎉✨🔥'), null);

const longText = 'This is a sufficiently distinctive assistant response that should be safe for responseMap fallback routing.';
const longKey = contentKey(longText);
assert.equal(typeof longKey, 'string');
assert.ok(longKey.length <= 200);
assert.ok(longKey.startsWith('This is a sufficiently distinctive assistant response'));

const noisyWhitespace = 'hello   world\n\tthis response has     enough distinctive words to be eligible for fallback routing';
assert.equal(
    contentKey(noisyWhitespace),
    'hello world this response has enough distinctive words to be eligible for fallback routing'
);

const tooLong = `${'x'.repeat(210)} trailing text that should be truncated`;
assert.equal(contentKey(tooLong).length, 200);

console.log('responseMap key policy tests passed');
