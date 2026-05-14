'use strict';

// Helpers that materialise OpenAI Chat Completions response payloads (both
// streaming SSE chunks and non-streaming JSON). Kept pure: callers pass the
// response object + already-assembled deltas, and these helpers know nothing
// about routing or Claude.

function buildUsagePayload(finalUsage) {
    const totalInput =
        (finalUsage.input_tokens || 0)
        + (finalUsage.cache_creation_tokens || 0)
        + (finalUsage.cache_read_tokens || 0);
    return {
        prompt_tokens:     totalInput,
        completion_tokens: finalUsage.output_tokens,
        total_tokens:      totalInput + (finalUsage.output_tokens || 0),
        prompt_tokens_details: {
            cached_tokens: finalUsage.cache_read_tokens,
            cache_creation_tokens: finalUsage.cache_creation_tokens,
        },
    };
}

function createdSeconds() {
    return Math.floor(Date.now() / 1000);
}

function writeSseChunk(res, completionId, model, delta, finishReason = null) {
    const chunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created: createdSeconds(),
        model,
        choices: [{
            index: 0,
            delta: finishReason ? {} : { role: 'assistant', content: delta },
            finish_reason: finishReason,
        }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function writeToolCallsStream(res, completionId, model, toolCalls, usagePayload) {
    const tcDelta = {
        id: completionId, object: 'chat.completion.chunk',
        created: createdSeconds(), model,
        choices: [{ index: 0, delta: {
            tool_calls: toolCalls.map((tc, i) => ({
                index: i,
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })),
        }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(tcDelta)}\n\n`);

    const stopChunk = {
        id: completionId, object: 'chat.completion.chunk',
        created: createdSeconds(), model,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    };
    res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);

    const usageChunk = {
        id: completionId, object: 'chat.completion.chunk',
        created: createdSeconds(), model,
        choices: [],
        usage: usagePayload,
    };
    res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
}

function writeStopStream(res, completionId, model, usagePayload) {
    const stopChunk = {
        id: completionId, object: 'chat.completion.chunk',
        created: createdSeconds(), model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
    res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);

    const usageChunk = {
        id: completionId, object: 'chat.completion.chunk',
        created: createdSeconds(), model,
        choices: [],
        usage: usagePayload,
    };
    res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
}

function buildToolCallsNonStream(completionId, model, toolCalls, usagePayload) {
    return {
        id: completionId, object: 'chat.completion',
        created: createdSeconds(), model,
        choices: [{ index: 0, message: {
            role: 'assistant',
            content: null,
            tool_calls: toolCalls.map((tc, i) => ({
                id: tc.id, index: i, type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })),
        }, finish_reason: 'tool_calls' }],
        usage: usagePayload,
    };
}

function buildTextNonStream(completionId, model, cleanText, usagePayload) {
    return {
        id: completionId, object: 'chat.completion',
        created: createdSeconds(), model,
        choices: [{ index: 0, message: { role: 'assistant', content: cleanText || '' }, finish_reason: 'stop' }],
        usage: usagePayload,
    };
}

module.exports = {
    buildUsagePayload,
    writeSseChunk,
    writeToolCallsStream,
    writeStopStream,
    buildToolCallsNonStream,
    buildTextNonStream,
};
