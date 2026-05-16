'use strict';

const assert = require('assert');
const { cleanResponseText, hasInternalBridgeMarkup, parseToolCallsDetailed, redactSensitivePreview, stripCodeContexts } = require('../src/tool-parser');

const allowed = new Set(['exec', 'read']);
const open = '<tool_call>';
const close = '</tool_call>';

{
    const result = parseToolCallsDetailed('<tool_call>{"name":"exec","arguments":{"command":"echo ok"}}</tool_call>', { allowedToolNames: allowed });
    assert.strictEqual(result.calls.length, 1);
    assert.strictEqual(result.repaired, false);
    assert.strictEqual(result.calls[0].name, 'exec');
    assert.deepStrictEqual(result.calls[0].arguments, { command: 'echo ok' });
}

{
    const result = parseToolCallsDetailed('<tool_call>{"name":"exec","arguments":{"command":"grep x file"}}</tool_char>', { allowedToolNames: allowed });
    assert.strictEqual(result.calls.length, 1);
    assert.strictEqual(result.repaired, true);
    assert.strictEqual(result.closeTag, '</tool_char>');
    assert.strictEqual(result.calls[0].name, 'exec');
}

{
    const result = parseToolCallsDetailed('prefix <tool_call>{"name":"read","arguments":{"path":"a"}}', { allowedToolNames: allowed });
    assert.strictEqual(result.calls.length, 1);
    assert.strictEqual(result.repaired, true);
    assert.strictEqual(result.closeTag, 'EOF');
    assert.strictEqual(result.calls[0].name, 'read');
}

{
    const result = parseToolCallsDetailed('<tool_call>{"name":"gateway","arguments":{}}</tool_char>', { allowedToolNames: allowed });
    assert.strictEqual(result.calls.length, 0);
    assert.strictEqual(result.repaired, false);
    assert.strictEqual(result.malformedReason, 'tool_not_allowed');
}

{
    const result = parseToolCallsDetailed('<tool_call>{"name":"gateway","arguments":{}}</tool_call>', { allowedToolNames: new Set() });
    assert.strictEqual(result.calls.length, 0);
    assert.strictEqual(result.hadToolCallMarkup, true);
    assert.strictEqual(result.errors[0].error, 'tool_not_allowed');
}

{
    const result = parseToolCallsDetailed('<tool_call>{"name":"read","arguments":{"path":"README.md"}}</tool_call>', { allowedToolNames: allowed });
    assert.strictEqual(result.calls.length, 1, 'valid allowed markup must parse as a tool call, not suppressed text');
    assert.strictEqual(result.errors.length, 0);
}

{
    const result = parseToolCallsDetailed('<tool_call>{"name":"exec","arguments":{}}</tool_char><tool_call>{"name":"read","arguments":{}}</tool_char>', { allowedToolNames: allowed });
    assert.strictEqual(result.calls.length, 0);
    assert.strictEqual(result.repaired, false);
    assert.strictEqual(result.malformedReason, 'multiple_tool_call_blocks');
}

{
    const cleaned = cleanResponseText('hello\n<tool_call>{"name":"exec","arguments":{"command":"echo nope"}}</tool_char>\nworld');
    assert.strictEqual(cleaned, 'hello\n\nworld');
}

{
    const cleaned = cleanResponseText('hello\n<tool_call>{"name":"exec","arguments":{"command":"echo nope"}}');
    assert.strictEqual(cleaned, 'hello');
}

{
    assert.strictEqual(hasInternalBridgeMarkup('<tool_call>{"name":"exec"}'), true);
    assert.strictEqual(hasInternalBridgeMarkup('plain text only'), false);
}

{
    const input = [
        'Example only:',
        '```json',
        `${open}{"name":"exec","arguments":{"command":"echo fenced"}}${close}`,
        '```',
    ].join('\n');
    const result = parseToolCallsDetailed(input, { allowedToolNames: allowed });
    assert.strictEqual(result.calls.length, 0);
    assert.strictEqual(result.hadToolCallMarkup, false);
    assert.strictEqual(hasInternalBridgeMarkup(input), false);
}

{
    const input = `Example only: \`${open}{"name":"exec","arguments":{"command":"echo inline"}}${close}\``;
    const result = parseToolCallsDetailed(input, { allowedToolNames: allowed });
    assert.strictEqual(result.calls.length, 0);
    assert.strictEqual(result.hadToolCallMarkup, false);
    assert.strictEqual(hasInternalBridgeMarkup(input), false);
}

{
    const input = `${open}{"name":"read","arguments":{"path":"real.txt"}}${close}`;
    const result = parseToolCallsDetailed(input, { allowedToolNames: allowed });
    assert.strictEqual(result.calls.length, 1);
    assert.strictEqual(result.calls[0].name, 'read');
    assert.deepStrictEqual(result.calls[0].arguments, { path: 'real.txt' });
}

{
    const input = [
        'Run this:',
        `${open}{"name":"exec","arguments":{"command":"echo real"}}${close}`,
        '',
        'Example only:',
        '```',
        `${open}{"name":"read","arguments":{"path":"example.txt"}}${close}`,
        '```',
    ].join('\n');
    const result = parseToolCallsDetailed(input, { allowedToolNames: allowed });
    assert.strictEqual(result.calls.length, 1);
    assert.strictEqual(result.calls[0].name, 'exec');
    assert.deepStrictEqual(result.calls[0].arguments, { command: 'echo real' });
}

{
    const input = `${open}{"name":"exec","arguments":${close}`;
    const result = parseToolCallsDetailed(input, { allowedToolNames: allowed });
    assert.strictEqual(result.calls.length, 0);
    assert.strictEqual(result.hadToolCallMarkup, true);
    assert.ok(result.errors.length > 0 || result.malformedReason);
}

{
    const inputs = [
        `before \`${open}{"name":"exec","arguments":{}}${close}\` after`,
        ['```js', '`inline-looking`', `${open}{"name":"exec","arguments":{}}${close}`, '```'].join('\n'),
        ['```python', `${open}{"name":"exec","arguments":{}}`, 'unterminated'].join('\n'),
    ];
    for (const input of inputs) {
        assert.strictEqual(stripCodeContexts(input).length, input.length);
    }
    const loneBacktick = `leave this lone \` ${open}{"name":"exec","arguments":{}}${close}`;
    assert.strictEqual(stripCodeContexts(loneBacktick), loneBacktick);
}

{
    const redacted = redactSensitivePreview('OPENAI_API_KEY=sk-abc123456789 token=supersecret password=hunter2');
    assert.ok(!redacted.includes('abc123456789'));
    assert.ok(!redacted.includes('supersecret'));
    assert.ok(!redacted.includes('hunter2'));
}

console.log('tool-parser tests passed');
