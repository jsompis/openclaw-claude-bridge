'use strict';

const { classifyParts, classifyPartsAsync, AttachmentBudgetError } = require('./attachments');

/**
 * Convert an OpenAI messages array into the bridge's internal shape.
 *
 * Returns:
 *   {
 *     systemPrompt: string,
 *     promptText: string,        // text-mode stdin
 *     attachmentBlocks: array,   // Anthropic content blocks for the FINAL user
 *                                // turn (image, document); empty if no
 *                                // attachments present in the latest user turn
 *   }
 *
 * The bridge sends `promptText` via plain stdin when attachmentBlocks is empty.
 * Otherwise it builds a stream-json input where the final user message has the
 * attachment blocks appended, and the prior conversation is rendered as text
 * via the standard <previous_response>/<tool_result> wrapping.
 *
 * Attachment behavior is controlled by OPENCLAW_BRIDGE_ATTACHMENT_MODE
 * (passthrough = default, describe = drop non-text parts).
 *
 * Handles the full OpenAI message format including tool_calls and tool results
 * so Claude can see the complete conversation history.
 */
function convertMessages(messages, opts = {}) {
    const { turnId = `t-${Date.now().toString(36)}` } = opts;
    return _convertMessagesWith(messages, turnId, _classify, _classifyToText);
}

async function convertMessagesAsync(messages, opts = {}) {
    const { turnId = `t-${Date.now().toString(36)}` } = opts;
    return _convertMessagesWithAsync(messages, turnId, _classifyAsync, _classifyToTextAsync);
}

function _lastUserIndex(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') return i;
    }
    return -1;
}

function _appendAssistantMessage(conversationParts, msg, text) {
    // Include both text content and any tool_calls from history
    const parts = [];
    if (text) parts.push(text);

    // Include tool_calls so Claude knows what was previously requested
    if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
            const fn = tc.function || {};
            parts.push(`<tool_call>\n{"name": "${fn.name}", "arguments": ${fn.arguments || '{}'}}\n</tool_call>`);
        }
    }

    if (parts.length > 0) {
        conversationParts.push(`<previous_response>\n${parts.join('\n')}\n</previous_response>`);
    }
}

function _convertMessagesWith(messages, turnId, classify, classifyToText) {
    const systemParts = [];
    const conversationParts = [];
    let lastUserAttachments = [];

    // Locate the index of the last user message so we know where to attach
    // multimodal blocks. Attachments on earlier user turns get inlined as
    // text-mode descriptions (we don't try to interleave images across turns
    // because the CLI's session resume needs a single coherent transcript).
    const lastUserIdx = _lastUserIndex(messages);

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const role = msg.role;
        const isLastUser = (i === lastUserIdx);

        if (role === 'developer' || role === 'system') {
            systemParts.push(classifyToText(msg.content, turnId));
        } else if (role === 'user') {
            const { text, attachments } = classify(msg.content, turnId);
            if (isLastUser && attachments.length > 0) {
                lastUserAttachments = attachments;
            }
            conversationParts.push(`User: ${text}`);
        } else if (role === 'assistant') {
            _appendAssistantMessage(conversationParts, msg, classifyToText(msg.content, turnId));
        } else if (role === 'tool') {
            // Tool results from OC's execution — include so Claude can use them
            const toolName = msg.name || '';
            const toolId = msg.tool_call_id || '';
            const text = classifyToText(msg.content, turnId);
            if (text) {
                conversationParts.push(`<tool_result name="${toolName}" tool_call_id="${toolId}">\n${text}\n</tool_result>`);
            }
        }
    }

    return {
        systemPrompt: systemParts.join('\n\n'),
        promptText: conversationParts.join('\n\n'),
        attachmentBlocks: lastUserAttachments,
    };
}

async function _convertMessagesWithAsync(messages, turnId, classify, classifyToText) {
    const systemParts = [];
    const conversationParts = [];
    let lastUserAttachments = [];
    const lastUserIdx = _lastUserIndex(messages);

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const role = msg.role;
        const isLastUser = (i === lastUserIdx);

        if (role === 'developer' || role === 'system') {
            systemParts.push(await classifyToText(msg.content, turnId));
        } else if (role === 'user') {
            const { text, attachments } = await classify(msg.content, turnId);
            if (isLastUser && attachments.length > 0) {
                lastUserAttachments = attachments;
            }
            conversationParts.push(`User: ${text}`);
        } else if (role === 'assistant') {
            _appendAssistantMessage(conversationParts, msg, await classifyToText(msg.content, turnId));
        } else if (role === 'tool') {
            const toolName = msg.name || '';
            const toolId = msg.tool_call_id || '';
            const text = await classifyToText(msg.content, turnId);
            if (text) {
                conversationParts.push(`<tool_result name="${toolName}" tool_call_id="${toolId}">\n${text}\n</tool_result>`);
            }
        }
    }

    return {
        systemPrompt: systemParts.join('\n\n'),
        promptText: conversationParts.join('\n\n'),
        attachmentBlocks: lastUserAttachments,
    };
}

function _classify(content, turnId) {
    try {
        return classifyParts(content, turnId);
    } catch (err) {
        if (err instanceof AttachmentBudgetError) {
            console.warn(`[convert.js] ${err.message}`);
            return { text: '[attachments dropped: budget]', attachments: [] };
        }
        console.warn(`[convert.js] classify failed: ${err.message}`);
        return { text: String(content || ''), attachments: [] };
    }
}

async function _classifyAsync(content, turnId) {
    try {
        return await classifyPartsAsync(content, turnId);
    } catch (err) {
        if (err instanceof AttachmentBudgetError) {
            console.warn(`[convert.js] ${err.message}`);
            return { text: '[attachments dropped: budget]', attachments: [] };
        }
        console.warn(`[convert.js] classify failed: ${err.message}`);
        return { text: String(content || ''), attachments: [] };
    }
}

function _classifyToText(content, turnId) {
    const { text } = _classify(content, turnId);
    return text;
}

async function _classifyToTextAsync(content, turnId) {
    const { text } = await _classifyAsync(content, turnId);
    return text;
}

/**
 * Extract plain text from a content field (string or array of parts).
 * Kept for backward compatibility with any direct callers.
 */
function extractContent(content) {
    if (typeof content === 'string') return content;
    if (content === null || content === undefined) return '';
    if (Array.isArray(content)) {
        return content
            .filter(p => p.type === 'text')
            .map(p => p.text)
            .join('\n');
    }
    return String(content ?? '');
}

/**
 * Extract only the new messages after the last assistant tool_calls message.
 * Used for --resume mode (tool loop) to avoid re-sending the full history.
 *
 * Returns {newText, attachmentBlocks} or null if no tool_calls found.
 */
function extractNewMessages(messages, opts = {}) {
    const { toolResultCap = 15000, turnId = `t-${Date.now().toString(36)}` } = opts;
    return _extractNewMessagesWith(messages, toolResultCap, turnId, _classify);
}

async function extractNewMessagesAsync(messages, opts = {}) {
    const { toolResultCap = 15000, turnId = `t-${Date.now().toString(36)}` } = opts;
    return _extractNewMessagesWithAsync(messages, toolResultCap, turnId, _classifyAsync);
}

function _lastAssistantToolCallIndex(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant' && Array.isArray(messages[i].tool_calls) && messages[i].tool_calls.length > 0) {
            return i;
        }
    }
    return -1;
}

function _toolLoopIsOver(messages, lastToolCallIdx) {
    for (let i = lastToolCallIdx + 1; i < messages.length; i++) {
        if (messages[i].role === 'assistant') return true;
    }
    return false;
}

function _extractNewMessagesWith(messages, toolResultCap, turnId, classify) {
    const lastToolCallIdx = _lastAssistantToolCallIndex(messages);
    if (lastToolCallIdx === -1) return null;
    if (_toolLoopIsOver(messages, lastToolCallIdx)) return null;

    const newMessages = messages.slice(lastToolCallIdx + 1);
    const lastUserIdx = _lastUserIndex(newMessages);
    const parts = [];
    let attachmentBlocks = [];

    for (let i = 0; i < newMessages.length; i++) {
        const msg = newMessages[i];
        if (msg.role === 'tool') {
            const toolName = msg.name || '';
            const toolId = msg.tool_call_id || '';
            let { text } = classify(msg.content, turnId);
            if (text) {
                if (text.length > toolResultCap) text = text.slice(0, toolResultCap) + '\n[... truncated]';
                parts.push(`<tool_result name="${toolName}" tool_call_id="${toolId}">\n${text}\n</tool_result>`);
            }
        } else if (msg.role === 'user') {
            const { text, attachments } = classify(msg.content, turnId);
            if (i === lastUserIdx && attachments.length > 0) attachmentBlocks = attachments;
            parts.push(`User: ${text}`);
        }
    }
    return { newText: parts.join('\n\n'), attachmentBlocks };
}

async function _extractNewMessagesWithAsync(messages, toolResultCap, turnId, classify) {
    const lastToolCallIdx = _lastAssistantToolCallIndex(messages);
    if (lastToolCallIdx === -1) return null;
    if (_toolLoopIsOver(messages, lastToolCallIdx)) return null;

    const newMessages = messages.slice(lastToolCallIdx + 1);
    const lastUserIdx = _lastUserIndex(newMessages);
    const parts = [];
    let attachmentBlocks = [];

    for (let i = 0; i < newMessages.length; i++) {
        const msg = newMessages[i];
        if (msg.role === 'tool') {
            const toolName = msg.name || '';
            const toolId = msg.tool_call_id || '';
            let { text } = await classify(msg.content, turnId);
            if (text) {
                if (text.length > toolResultCap) text = text.slice(0, toolResultCap) + '\n[... truncated]';
                parts.push(`<tool_result name="${toolName}" tool_call_id="${toolId}">\n${text}\n</tool_result>`);
            }
        } else if (msg.role === 'user') {
            const { text, attachments } = await classify(msg.content, turnId);
            if (i === lastUserIdx && attachments.length > 0) attachmentBlocks = attachments;
            parts.push(`User: ${text}`);
        }
    }
    return { newText: parts.join('\n\n'), attachmentBlocks };
}

/**
 * Extract messages after the last assistant message (regardless of tool_calls).
 * Used for --resume mode when the conversation has no tool_calls (simple continuation).
 *
 * Returns {newText, attachmentBlocks} or null if nothing new found.
 */
function extractNewUserMessages(messages, opts = {}) {
    const { toolResultCap = 15000, turnId = `t-${Date.now().toString(36)}` } = opts;
    return _extractNewUserMessagesWith(messages, toolResultCap, turnId, _classify);
}

async function extractNewUserMessagesAsync(messages, opts = {}) {
    const { toolResultCap = 15000, turnId = `t-${Date.now().toString(36)}` } = opts;
    return _extractNewUserMessagesWithAsync(messages, toolResultCap, turnId, _classifyAsync);
}

function _lastAssistantIndex(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') return i;
    }
    return -1;
}

function _extractNewUserMessagesWith(messages, toolResultCap, turnId, classify) {
    const lastAssistantIdx = _lastAssistantIndex(messages);
    if (lastAssistantIdx === -1) return null;

    const newMessages = messages.slice(lastAssistantIdx + 1);
    if (newMessages.length === 0) return null;

    const lastUserIdx = _lastUserIndex(newMessages);
    const parts = [];
    let attachmentBlocks = [];

    for (let i = 0; i < newMessages.length; i++) {
        const msg = newMessages[i];
        if (msg.role === 'user') {
            const { text, attachments } = classify(msg.content, turnId);
            if (i === lastUserIdx && attachments.length > 0) attachmentBlocks = attachments;
            if (text) parts.push(text);
        } else if (msg.role === 'tool') {
            const toolName = msg.name || '';
            const toolId = msg.tool_call_id || '';
            let { text } = classify(msg.content, turnId);
            if (text) {
                if (text.length > toolResultCap) text = text.slice(0, toolResultCap) + '\n[... truncated]';
                parts.push(`<tool_result name="${toolName}" tool_call_id="${toolId}">\n${text}\n</tool_result>`);
            }
        }
    }
    return parts.length > 0 ? { newText: parts.join('\n\n'), attachmentBlocks } : null;
}

async function _extractNewUserMessagesWithAsync(messages, toolResultCap, turnId, classify) {
    const lastAssistantIdx = _lastAssistantIndex(messages);
    if (lastAssistantIdx === -1) return null;

    const newMessages = messages.slice(lastAssistantIdx + 1);
    if (newMessages.length === 0) return null;

    const lastUserIdx = _lastUserIndex(newMessages);
    const parts = [];
    let attachmentBlocks = [];

    for (let i = 0; i < newMessages.length; i++) {
        const msg = newMessages[i];
        if (msg.role === 'user') {
            const { text, attachments } = await classify(msg.content, turnId);
            if (i === lastUserIdx && attachments.length > 0) attachmentBlocks = attachments;
            if (text) parts.push(text);
        } else if (msg.role === 'tool') {
            const toolName = msg.name || '';
            const toolId = msg.tool_call_id || '';
            let { text } = await classify(msg.content, turnId);
            if (text) {
                if (text.length > toolResultCap) text = text.slice(0, toolResultCap) + '\n[... truncated]';
                parts.push(`<tool_result name="${toolName}" tool_call_id="${toolId}">\n${text}\n</tool_result>`);
            }
        }
    }
    return parts.length > 0 ? { newText: parts.join('\n\n'), attachmentBlocks } : null;
}

/**
 * Compact version of convertMessages for context refresh.
 * Truncates assistant text and tool results to reduce prompt size.
 * Same return shape as convertMessages.
 */
function convertMessagesCompact(messages, opts = {}) {
    const {
        assistantCap = 1500,
        recentToolCap = 2000,
        oldToolCap = 500,
        recentTurns = 10,
        turnId = `t-${Date.now().toString(36)}`,
    } = opts;
    return _convertMessagesCompactWith(messages, { assistantCap, recentToolCap, oldToolCap, recentTurns, turnId }, _classify, _classifyToText);
}

async function convertMessagesCompactAsync(messages, opts = {}) {
    const {
        assistantCap = 1500,
        recentToolCap = 2000,
        oldToolCap = 500,
        recentTurns = 10,
        turnId = `t-${Date.now().toString(36)}`,
    } = opts;
    return _convertMessagesCompactWithAsync(messages, { assistantCap, recentToolCap, oldToolCap, recentTurns, turnId }, _classifyAsync, _classifyToTextAsync);
}

function _recentCutoff(messages, recentTurns) {
    let userTurnCount = 0;
    for (const msg of messages) {
        if (msg.role === 'user') userTurnCount++;
    }
    return Math.max(0, userTurnCount - recentTurns);
}

function _convertMessagesCompactWith(messages, opts, classify, classifyToText) {
    const { assistantCap, recentToolCap, oldToolCap, recentTurns, turnId } = opts;
    const systemParts = [];
    const conversationParts = [];
    let lastUserAttachments = [];
    const lastUserIdx = _lastUserIndex(messages);
    const recentCutoff = _recentCutoff(messages, recentTurns);

    let currentUserTurn = 0;
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const role = msg.role;

        if (role === 'developer' || role === 'system') {
            systemParts.push(classifyToText(msg.content, turnId));
        } else if (role === 'user') {
            currentUserTurn++;
            const { text, attachments } = classify(msg.content, turnId);
            if (i === lastUserIdx && attachments.length > 0) lastUserAttachments = attachments;
            conversationParts.push(`User: ${text}`);
        } else if (role === 'assistant') {
            const text = classifyToText(msg.content, turnId);
            const parts = [];
            if (text) {
                parts.push(text.length > assistantCap ? text.slice(0, assistantCap) + '\n[... truncated]' : text);
            }
            if (Array.isArray(msg.tool_calls)) {
                for (const tc of msg.tool_calls) {
                    const fn = tc.function || {};
                    parts.push(`<tool_call>\n{"name": "${fn.name}", "arguments": ${fn.arguments || '{}'}}\n</tool_call>`);
                }
            }
            if (parts.length > 0) {
                conversationParts.push(`<previous_response>\n${parts.join('\n')}\n</previous_response>`);
            }
        } else if (role === 'tool') {
            const toolName = msg.name || '';
            const toolId = msg.tool_call_id || '';
            const { text } = classify(msg.content, turnId);
            if (text) {
                const cap = currentUserTurn >= recentCutoff ? recentToolCap : oldToolCap;
                const truncated = text.length > cap ? text.slice(0, cap) + '\n[... truncated]' : text;
                conversationParts.push(`<tool_result name="${toolName}" tool_call_id="${toolId}">\n${truncated}\n</tool_result>`);
            }
        }
    }

    return {
        systemPrompt: systemParts.join('\n\n'),
        promptText: conversationParts.join('\n\n'),
        attachmentBlocks: lastUserAttachments,
    };
}

async function _convertMessagesCompactWithAsync(messages, opts, classify, classifyToText) {
    const { assistantCap, recentToolCap, oldToolCap, recentTurns, turnId } = opts;
    const systemParts = [];
    const conversationParts = [];
    let lastUserAttachments = [];
    const lastUserIdx = _lastUserIndex(messages);
    const recentCutoff = _recentCutoff(messages, recentTurns);

    let currentUserTurn = 0;
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const role = msg.role;

        if (role === 'developer' || role === 'system') {
            systemParts.push(await classifyToText(msg.content, turnId));
        } else if (role === 'user') {
            currentUserTurn++;
            const { text, attachments } = await classify(msg.content, turnId);
            if (i === lastUserIdx && attachments.length > 0) lastUserAttachments = attachments;
            conversationParts.push(`User: ${text}`);
        } else if (role === 'assistant') {
            const text = await classifyToText(msg.content, turnId);
            const parts = [];
            if (text) {
                parts.push(text.length > assistantCap ? text.slice(0, assistantCap) + '\n[... truncated]' : text);
            }
            if (Array.isArray(msg.tool_calls)) {
                for (const tc of msg.tool_calls) {
                    const fn = tc.function || {};
                    parts.push(`<tool_call>\n{"name": "${fn.name}", "arguments": ${fn.arguments || '{}'}}\n</tool_call>`);
                }
            }
            if (parts.length > 0) {
                conversationParts.push(`<previous_response>\n${parts.join('\n')}\n</previous_response>`);
            }
        } else if (role === 'tool') {
            const toolName = msg.name || '';
            const toolId = msg.tool_call_id || '';
            const { text } = await classify(msg.content, turnId);
            if (text) {
                const cap = currentUserTurn >= recentCutoff ? recentToolCap : oldToolCap;
                const truncated = text.length > cap ? text.slice(0, cap) + '\n[... truncated]' : text;
                conversationParts.push(`<tool_result name="${toolName}" tool_call_id="${toolId}">\n${truncated}\n</tool_result>`);
            }
        }
    }

    return {
        systemPrompt: systemParts.join('\n\n'),
        promptText: conversationParts.join('\n\n'),
        attachmentBlocks: lastUserAttachments,
    };
}

module.exports = {
    convertMessages,
    convertMessagesAsync,
    convertMessagesCompact,
    convertMessagesCompactAsync,
    extractNewMessages,
    extractNewMessagesAsync,
    extractNewUserMessages,
    extractNewUserMessagesAsync,
    extractContent,
};
