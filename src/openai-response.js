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

function isWritable(res) {
    return Boolean(res && !res.destroyed && !res.writableEnded && !res.writableFinished);
}

function safeWrite(res, payload) {
    if (!isWritable(res)) return false;
    try {
        return res.write(payload);
    } catch (err) {
        if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED')) return false;
        throw err;
    }
}

function safeEnd(res) {
    if (!isWritable(res)) return false;
    try {
        res.end();
        return true;
    } catch (err) {
        if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED')) return false;
        throw err;
    }
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
    return safeWrite(res, `data: ${JSON.stringify(chunk)}\n\n`);
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
    if (!safeWrite(res, `data: ${JSON.stringify(tcDelta)}\n\n`)) return false;

    const stopChunk = {
        id: completionId, object: 'chat.completion.chunk',
        created: createdSeconds(), model,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    };
    if (!safeWrite(res, `data: ${JSON.stringify(stopChunk)}\n\n`)) return false;

    const usageChunk = {
        id: completionId, object: 'chat.completion.chunk',
        created: createdSeconds(), model,
        choices: [],
        usage: usagePayload,
    };
    if (!safeWrite(res, `data: ${JSON.stringify(usageChunk)}\n\n`)) return false;
    if (!safeWrite(res, 'data: [DONE]\n\n')) return false;
    return safeEnd(res);
}

function writeStopStream(res, completionId, model, usagePayload) {
    const stopChunk = {
        id: completionId, object: 'chat.completion.chunk',
        created: createdSeconds(), model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
    if (!safeWrite(res, `data: ${JSON.stringify(stopChunk)}\n\n`)) return false;

    const usageChunk = {
        id: completionId, object: 'chat.completion.chunk',
        created: createdSeconds(), model,
        choices: [],
        usage: usagePayload,
    };
    if (!safeWrite(res, `data: ${JSON.stringify(usageChunk)}\n\n`)) return false;
    if (!safeWrite(res, 'data: [DONE]\n\n')) return false;
    return safeEnd(res);
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
    isWritable,
    safeWrite,
    safeEnd,
};
