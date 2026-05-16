'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');

const {
  isWritable,
  safeEnd,
  safeWrite,
  writeSseChunk,
  writeStopStream,
  writeToolCallsStream,
} = require('../src/openai-response');

class FakeResponse extends EventEmitter {
  constructor({ throwCode = null, destroyed = false } = {}) {
    super();
    this.throwCode = throwCode;
    this.destroyed = destroyed;
    this.writableEnded = false;
    this.writableFinished = false;
    this.writes = [];
    this.ended = false;
  }

  write(payload) {
    if (this.throwCode) {
      const err = new Error(`write ${this.throwCode}`);
      err.code = this.throwCode;
      throw err;
    }
    this.writes.push(payload);
    return true;
  }

  end() {
    if (this.throwCode) {
      const err = new Error(`end ${this.throwCode}`);
      err.code = this.throwCode;
      throw err;
    }
    this.ended = true;
    this.writableEnded = true;
    this.writableFinished = true;
  }
}

function main() {
  const ok = new FakeResponse();
  assert.strictEqual(isWritable(ok), true);
  assert.strictEqual(safeWrite(ok, 'hello'), true);
  assert.deepStrictEqual(ok.writes, ['hello']);
  assert.strictEqual(safeEnd(ok), true);
  assert.strictEqual(ok.ended, true);

  const epipe = new FakeResponse({ throwCode: 'EPIPE' });
  assert.strictEqual(safeWrite(epipe, 'x'), false, 'EPIPE writes must be swallowed as client disconnects');
  assert.strictEqual(safeEnd(epipe), false, 'EPIPE end must be swallowed as client disconnects');
  assert.strictEqual(writeSseChunk(epipe, 'chatcmpl-test', 'model', 'delta'), false);
  assert.strictEqual(writeStopStream(epipe, 'chatcmpl-test', 'model', { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }), false);
  assert.strictEqual(writeToolCallsStream(epipe, 'chatcmpl-test', 'model', [{ id: 'call_1', name: 'noop', arguments: {} }], { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }), false);

  const destroyed = new FakeResponse({ destroyed: true });
  assert.strictEqual(isWritable(destroyed), false);
  assert.strictEqual(safeWrite(destroyed, 'x'), false);
  assert.strictEqual(safeEnd(destroyed), false);

  const hard = new FakeResponse({ throwCode: 'SOMETHING_ELSE' });
  assert.throws(() => safeWrite(hard, 'x'), /SOMETHING_ELSE/);

  console.log('openai response safe write tests passed');
}

main();
