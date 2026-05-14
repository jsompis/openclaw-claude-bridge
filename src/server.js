'use strict';

require('./env-loader').loadDefaultEnv();

const express = require('express');
const { v4: uuidv4 } = require('uuid');

const { convertMessagesAsync, convertMessagesCompactAsync, extractNewMessagesAsync, extractNewUserMessagesAsync } = require('./convert');
const { bridgeAllowedToolNames, buildToolInstructions } = require('./tools');
const { runClaude } = require('./claude');
const { cleanResponseText, hasInternalBridgeMarkup, parseToolCallsDetailed, redactSensitivePreview } = require('./tool-parser');

let runClaudeImpl = runClaude;

function __setRunClaudeForTests(fn) {
    runClaudeImpl = fn || runClaude;
}

const {
    extractRoutingSignals,
    pickRouting,
    MAIN_PRIORITY,
    MEMFLUSH_PRIORITY,
    headerValue,
    debugRawRequest,
    messageText,
} = require('./routing');

const {
    MAX_PER_CHANNEL,
    MAX_GLOBAL,
    stats,
    channelMap,
    sessionMap,
    responseMap,
    channelActive,
    pushLog,
    pushActivity,
    contentKey,
    gcMemory,
    purgeCliSession,
    saveState,
} = require('./state-store');

const {
    buildUsagePayload,
    writeSseChunk,
    writeToolCallsStream,
    writeStopStream,
    buildToolCallsNonStream,
    buildTextNonStream,
} = require('./openai-response');

const { statusApp } = require('./dashboard-api');
const { getContextWindow } = require('./claude');

/**
 * OpenClaw sometimes asks the configured model for a short session filename slug.
 * That request can include Discord metadata and tools, so if it is proxied into a
 * per-channel Claude CLI session it poisons the channel: future real prompts resume
 * a title-generation conversation and Claude replies with the slug forever.
 * Intercept it before session routing and do not store channelMap/responseMap state.
 */
function isSessionTitleSlugRequest(messages) {
    return messages.some((msg) => {
        if (msg.role !== 'user') return false;
        const text = messageText(msg).trim();
        return /^(?:User:\s*)?Based on this conversation, generate a short 1-2 word filename slug\b/i.test(text)
            || /generate a short 1-2 word filename slug \(lowercase, hyphen-separated, no file extension\)/i.test(text);
    });
}

// ─── API app (port 3456, localhost only) ──────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'openclaw-claude-bridge' });
});

app.get('/v1/models', (req, res) => {
    res.json({
        object: 'list',
        data: [
            { id: 'claude-opus-4-7',   object: 'model', created: 1700000000, owned_by: 'anthropic' },
            { id: 'claude-opus-4-6',   object: 'model', created: 1700000000, owned_by: 'anthropic' },
            { id: 'claude-sonnet-4-6', object: 'model', created: 1700000000, owned_by: 'anthropic' },
            { id: 'claude-haiku-4-5',  object: 'model', created: 1700000000, owned_by: 'anthropic' },
        ],
    });
});

app.post('/v1/chat/completions', async (req, res) => {
    const requestId = uuidv4().slice(0, 8);
    const startTime = Date.now();

    stats.totalRequests++;
    stats.activeRequests++;
    stats.lastRequestAt = new Date();
    let acquiredChannel = null; // routingKey if channelActive was incremented

    console.log(`[${requestId}] POST /v1/chat/completions`);
    // Debug: log OC session identifiers
    const ocSessionKey = headerValue(req.headers['x-openclaw-session-key']);
    const ocUser = req.body?.user || null;
    if (ocSessionKey || ocUser) {
        console.log(`[${requestId}] OC identifiers: session-key=${ocSessionKey} user=${ocUser}`);
    }

    const logEntry = {
        id: requestId,
        at: new Date().toISOString(),
        model: null,
        tools: 0,
        promptLen: 0,
        inputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        durationMs: null,
        status: 'pending',
        error: null,
        activity: [],
        cliSessionId: null,
        resumed: false,
        channel: null,
        effort: null,
        thinking: false,
        resumeMethod: null,
        routingSource: null,
    };
    pushLog(logEntry); // appear in dashboard immediately as 'pending'

    try {
        const { messages = [], tools = [], model = 'claude-opus-4-7', stream = true, reasoning_effort, user, prompt_cache_key } = req.body;
        debugRawRequest(requestId, req, messages);
        stats.lastModel = model;
        logEntry.model = model;
        logEntry.contextWindow = getContextWindow(model);
        logEntry.tools = tools.length;
        logEntry.effort = reasoning_effort || null;
        logEntry.thinking = !!reasoning_effort;
        if (reasoning_effort) console.log(`[${requestId}] reasoning_effort=${reasoning_effort}`);

        if (isSessionTitleSlugRequest(messages)) {
            const promptLen = messages.reduce((s, m) => s + messageText(m).length, 0);
            console.warn(`[${requestId}] SESSION TITLE intercepted: tools=${tools.length} promptLen≈${promptLen}, returning NO_REPLY without session routing`);
            logEntry.status = 'ok';
            logEntry.resumeMethod = 'session_title_intercept';
            logEntry.promptLen = promptLen;
            logEntry.durationMs = Date.now() - startTime;
            pushActivity(requestId, '🏷️ session title intercepted');
            return res.json({
                id: `chatcmpl-${requestId}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, message: { role: 'assistant', content: 'NO_REPLY' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            });
        }

        const allowedToolNames = bridgeAllowedToolNames(tools);
        if (tools.length > 0) {
            const toolNames = Array.from(allowedToolNames);
            console.log(`[${requestId}] tools:[${toolNames.join(',')}]`);
        }

        // Memory flush interception: OC sends tools=0 before compaction, no need to proxy to CLI
        if (tools.length === 0) {
            const promptLen = messages.reduce((s, m) => s + JSON.stringify(m.content || '').length, 0);
            const mfSignals = extractRoutingSignals({ req, body: req.body, messages });
            const mfRouting = pickRouting(mfSignals, MEMFLUSH_PRIORITY);
            logEntry.channel = mfRouting.displayChannel
                ? mfRouting.displayChannel.replace(/^Guild\s+/, '').slice(0, 40)
                : null;
            logEntry.routingSource = mfRouting.routingSource;
            logEntry.agent = mfSignals.agentName || null;
            console.log(`[${requestId}] MEMORY FLUSH intercepted: tools=0 channel="${mfRouting.displayChannel}" source=${mfRouting.routingSource || 'none'} agent="${mfSignals.agentName}" promptLen≈${promptLen}, returning NO_REPLY`);
            logEntry.status = 'ok';
            logEntry.resumeMethod = 'memflush';
            logEntry.promptLen = promptLen;
            logEntry.durationMs = Date.now() - startTime;
            pushActivity(requestId, `🧹 memflush intercepted (${Math.round(promptLen/1000)}K chars)`);
            return res.json({
                id: `chatcmpl-${requestId}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, message: { role: 'assistant', content: 'NO_REPLY' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            });
        }

        // OC /new startup requests now surface user-visible failures if we return a synthetic
        // empty stop payload here. Let them flow through to Claude so Forge gets a real first turn.

        // --- Session reuse detection ---
        gcMemory();
        let isResume = false;
        let resumeSessionId = null;

        // Extract conversation identity (5-source priority defined in routing.js).
        const signals = extractRoutingSignals({ req, body: req.body, messages });
        const { convLabel, inboundContext, inboundLabel, agentName, openAiUser, promptCacheKey } = signals;
        const routing = pickRouting(signals, MAIN_PRIORITY);
        const { routingSource, routingKey } = routing;
        logEntry.routingSource = routingSource;
        if (routingKey) {
            console.log(`[${requestId}] OC channel: "${convLabel || ocSessionKey || inboundLabel || promptCacheKey || openAiUser}" source=${routingSource} agent: "${agentName || '(none)'}" routingKey: "${routingKey}"`);
        }

        // --- Per-channel and global concurrent limits ---
        if (stats.activeRequests > MAX_GLOBAL) {
            console.warn(`[${requestId}] BLOCKED: global limit (${MAX_GLOBAL} concurrent)`);
            logEntry.status = 'error';
            logEntry.error = 'Global concurrent limit';
            return res.status(429).json({ error: { message: `Too many concurrent requests (max ${MAX_GLOBAL})`, type: 'rate_limit' } });
        }
        if (routingKey) {
            const active = channelActive.get(routingKey) || 0;
            if (active >= MAX_PER_CHANNEL) {
                console.warn(`[${requestId}] BLOCKED: "${routingKey}" has ${active} in-flight (max ${MAX_PER_CHANNEL})`);
                logEntry.status = 'error';
                logEntry.error = 'Per-channel concurrent limit';
                return res.status(429).json({ error: { message: `Too many concurrent requests for this channel (max ${MAX_PER_CHANNEL})`, type: 'rate_limit' } });
            }
            channelActive.set(routingKey, active + 1);
            acquiredChannel = routingKey;
        }

        // 1) Check channelMap (primary: OC conversation → CLI session)
        if (!isResume && routingKey && channelMap.has(routingKey)) {
            resumeSessionId = channelMap.get(routingKey).sessionId;
            isResume = true;
            console.log(`[${requestId}] channelMap hit: "${routingKey}" → session=${resumeSessionId.slice(0, 8)}`);
        }
        // Detect /new after channelMap hit: if the first assistant message is the
        // "New session started" marker and there are NO other assistant messages
        // (bridge hasn't replied yet), this is the first request after /new.
        if (isResume && routingKey && channelMap.has(routingKey)) {
            const assistantMsgs = messages.filter(m => m.role === 'assistant');
            if (assistantMsgs.length === 1) {
                const c = typeof assistantMsgs[0].content === 'string' ? assistantMsgs[0].content
                    : Array.isArray(assistantMsgs[0].content) ? assistantMsgs[0].content.filter(p => p.type === 'text').map(p => p.text).join('') : '';
                if (c.includes('New session started')) {
                    console.log(`[${requestId}] /new detected after channelMap hit: purging old session=${resumeSessionId.slice(0, 8)}`);
                    purgeCliSession(resumeSessionId);
                    channelMap.delete(routingKey);
                    isResume = false;
                    resumeSessionId = null;
                }
            }
        }
        // 2) Check tool_call_ids (tool loop continuation)
        if (!isResume) {
            for (const msg of messages) {
                if (msg.role === 'tool' && msg.tool_call_id && sessionMap.has(msg.tool_call_id)) {
                    resumeSessionId = sessionMap.get(msg.tool_call_id).sessionId;
                    isResume = true;
                    break;
                }
            }
        }
        // 3) Check assistant response content (fallback for DMs or missing label)
        if (!isResume) {
            for (const msg of messages) {
                if (msg.role === 'assistant') {
                    let text = msg.content;
                    if (Array.isArray(text)) {
                        text = text.filter(p => p.type === 'text').map(p => p.text).join('\n');
                    }
                    const key = contentKey(typeof text === 'string' ? text : null);
                    if (key && responseMap.has(key)) {
                        resumeSessionId = responseMap.get(key).sessionId;
                        isResume = true;
                        console.log(`[${requestId}] responseMap hit: key="${key.slice(0, 50)}..." → session=${resumeSessionId.slice(0, 8)}`);
                        break;
                    }
                }
            }
            if (!isResume && messages.some(m => m.role === 'assistant')) {
                const assistantKeys = messages.filter(m => m.role === 'assistant').map(m => {
                    let t = m.content;
                    if (Array.isArray(t)) t = t.filter(p => p.type === 'text').map(p => p.text).join('\n');
                    return contentKey(typeof t === 'string' ? t : null);
                }).filter(Boolean);
                console.log(`[${requestId}] responseMap miss: tried ${assistantKeys.length} keys, map size=${responseMap.size}`);
                if (assistantKeys.length > 0) console.log(`[${requestId}]   first key: "${assistantKeys[0].slice(0, 60)}..."`);
            }
        }

        // Context refresh: detect OC compaction via summary hash → sync CLI
        if (isResume && routingKey && channelMap.has(routingKey)) {
            const COMPACTION_PREFIX = 'The conversation history before this point was compacted into the following summary:';
            let compactionHash = null;
            for (const m of messages) {
                if (m.role !== 'user') continue;
                const text = typeof m.content === 'string' ? m.content
                    : Array.isArray(m.content) ? m.content.filter(p => p.type === 'text').map(p => p.text || '').join('') : '';
                if (text.startsWith(COMPACTION_PREFIX)) {
                    const snippet = text.slice(0, 500);
                    let h = 0;
                    for (let i = 0; i < snippet.length; i++) { h = ((h << 5) - h + snippet.charCodeAt(i)) | 0; }
                    compactionHash = h;
                    break;
                }
            }

            const entry = channelMap.get(routingKey);
            const lastHash = entry?.lastCompactionHash ?? null;

            if (compactionHash !== null && compactionHash !== lastHash) {
                const inToolLoop = await extractNewMessagesAsync(messages) !== null;
                if (!inToolLoop) {
                    const compactResult = await convertMessagesCompactAsync(messages);
                    if (compactResult.promptText.length > 1500000) {
                        console.log(`[${requestId}] REFRESH SKIPPED: compact prompt too long (${compactResult.promptText.length})`);
                    } else {
                        const oldSid = entry.sessionId;
                        console.log(`[${requestId}] CONTEXT REFRESH (hash=${compactionHash}): ${oldSid.slice(0, 8)} → new session (compact ${compactResult.promptText.length} chars)`);
                        logEntry.resumeMethod = 'refresh';
                        logEntry.refreshPrompt = compactResult.promptText;
                        logEntry.refreshSystemPrompt = compactResult.systemPrompt;
                        logEntry.refreshAttachmentBlocks = compactResult.attachmentBlocks || [];
                        logEntry.pendingCompactionHash = compactionHash;
                        purgeCliSession(oldSid);
                        channelMap.delete(routingKey);
                        isResume = false;
                        resumeSessionId = null;
                    }
                } else {
                    console.log(`[${requestId}] REFRESH DEFERRED: tool loop in progress (hash=${compactionHash})`);
                }
            }
        }

        let promptText;
        let combinedSystemPrompt;
        let sessionId;
        let attachmentBlocks = [];

        // Always build system prompt (not persisted in CLI session)
        const { systemPrompt: devSystemPrompt } = await convertMessagesAsync(messages);
        const toolInstructions = buildToolInstructions(tools);
        combinedSystemPrompt = devSystemPrompt
            ? `${devSystemPrompt}${toolInstructions}`
            : toolInstructions || undefined;

        if (isResume) {
            // Resume mode: only send new messages as prompt
            sessionId = resumeSessionId;
            // 1) Try tool loop extraction (messages after last assistant tool_calls)
            const newToolLoop = await extractNewMessagesAsync(messages);
            // 2) Try conversation continuation (messages after last assistant message)
            const newCont = !newToolLoop ? await extractNewUserMessagesAsync(messages) : null;
            if (newToolLoop) {
                promptText = newToolLoop.newText;
                attachmentBlocks = newToolLoop.attachmentBlocks || [];
                logEntry.resumeMethod = 'tool_loop';
                console.log(`[${requestId}] RESUME session=${sessionId.slice(0, 8)} newPromptLen=${promptText.length} (tool loop)${attachmentBlocks.length ? ` +${attachmentBlocks.length} attachment(s)` : ''}`);
                pushActivity(requestId, `🔄 resuming session (${promptText.length} chars new)`);
            } else if (newCont) {
                promptText = newCont.newText;
                attachmentBlocks = newCont.attachmentBlocks || [];
                logEntry.resumeMethod = 'continuation';
                console.log(`[${requestId}] RESUME session=${sessionId.slice(0, 8)} newPromptLen=${promptText.length} (continuation)${attachmentBlocks.length ? ` +${attachmentBlocks.length} attachment(s)` : ''}`);
                pushActivity(requestId, `🔄 resuming session (${promptText.length} chars new)`);
            } else if (routingKey && !messages.some(m => m.role === 'assistant')) {
                // OpenAI-compatible clients often send only the latest user message
                // while relying on the `user` routing key for continuity. In that
                // shape there is no assistant anchor for extractNewUserMessages(),
                // but we still should resume the mapped Claude CLI session and send
                // the current user turn.
                const full = await convertMessagesAsync(messages);
                promptText = full.promptText;
                attachmentBlocks = full.attachmentBlocks || [];
                logEntry.resumeMethod = 'user_key_continuation';
                console.log(`[${requestId}] RESUME session=${sessionId.slice(0, 8)} promptLen=${promptText.length} (user key continuation)`);
                pushActivity(requestId, `🔄 resuming session (${promptText.length} chars via user key)`);
            } else {
                // Fallback: nothing new to send, use full history as new session
                logEntry.resumeMethod = 'fallback';
                isResume = false;
                sessionId = uuidv4();
                const full = await convertMessagesAsync(messages);
                promptText = full.promptText;
                attachmentBlocks = full.attachmentBlocks || [];
                console.log(`[${requestId}] RESUME fallback → new session=${sessionId.slice(0, 8)}`);
                pushActivity(requestId, `⏳ thinking... (${tools.length} tools) [resume fallback]`);
            }
        } else {
            // New session (or refresh)
            sessionId = uuidv4();
            if (logEntry.refreshPrompt) {
                promptText = logEntry.refreshPrompt;
                const refreshSys = logEntry.refreshSystemPrompt;
                if (refreshSys) {
                    combinedSystemPrompt = `${refreshSys}${toolInstructions}`;
                }
                attachmentBlocks = logEntry.refreshAttachmentBlocks || [];
                delete logEntry.refreshPrompt;
                delete logEntry.refreshSystemPrompt;
                delete logEntry.refreshAttachmentBlocks;
                console.log(`[${requestId}] NEW session=${sessionId.slice(0, 8)} (context refresh)`);
                pushActivity(requestId, `🔄 context refresh → new session (${promptText.length} chars)`);
            } else {
                const full = await convertMessagesAsync(messages);
                promptText = full.promptText;
                attachmentBlocks = full.attachmentBlocks || [];
                console.log(`[${requestId}] NEW session=${sessionId.slice(0, 8)}`);
                pushActivity(requestId, `⏳ thinking... (${tools.length} tools)`);
            }
        }

        logEntry.promptLen = promptText.length;
        logEntry.cliSessionId = sessionId.slice(0, 8);
        logEntry.resumed = isResume;
        logEntry.channel = routing.displayChannel
            ? routing.displayChannel.replace(/^Guild\s+/, '').slice(0, 40)
            : null;
        logEntry.agent = agentName || null;
        console.log(`[${requestId}] model=${model} tools=${tools.length} promptLen=${promptText.length} resume=${isResume}`);

        const isStream = stream !== false;
        if (isStream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.flushHeaders();
        }

        const completionId = `chatcmpl-${requestId}`;
        let chunksSent = 0;

        const sendChunk = (delta, finishReason = null) => {
            if (isStream) {
                writeSseChunk(res, completionId, model, delta, finishReason);
                chunksSent++;
            }
        };

        // Progress: logged server-side + captured for dashboard (not streamed to client)
        const onChunk = (text) => {
            const msg = text.trim();
            if (!msg) return;

            console.log(`[${requestId}] ${msg}`);
            logEntry.activity.push(msg);
            pushActivity(requestId, msg);
        };

        // Abort signal: kill Claude CLI when client disconnects before response is sent
        const ac = new AbortController();
        res.on('close', () => { if (!res.writableFinished) ac.abort(); });

        let finalText;
        let finalUsage = { input_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, output_tokens: 0, cost_usd: 0 };
        try {
            ({ text: finalText, usage: finalUsage } = await runClaudeImpl(combinedSystemPrompt, promptText, model, onChunk, ac.signal, reasoning_effort, sessionId, isResume, attachmentBlocks));
        } catch (err) {
            const errMessage = err?.message || 'Unknown Claude error';
            const emptyCompletion = /empty response/i.test(errMessage);
            const terminatedCompletion = /(^|\b)terminated(\b|$)/i.test(errMessage);
            const retryableFreshFailure = emptyCompletion || terminatedCompletion;
            const wasResume = isResume;

            // OC disconnected (timeout/restart) — not a CLI error, preserve session
            if (wasResume && errMessage === 'Client disconnected') {
                console.log(`[${requestId}] OC disconnected, preserving session=${sessionId.slice(0, 8)}`);
                logEntry.status = 'oc_disconnect';
                logEntry.error = errMessage;
                logEntry.durationMs = Date.now() - startTime;
                return;
            }

            // Retry resume failures with compact refresh, and retry empty/terminated
            // fresh-session failures once from a new Claude session.
            if (wasResume || retryableFreshFailure) {
                const retryLabel = wasResume ? 'compact refresh' : 'fresh session retry';
                if (retryableFreshFailure) {
                    const breadcrumb = terminatedCompletion ? '⚠ terminated_completion_retry' : '⚠ empty_completion_retry';
                    const breadcrumbLog = terminatedCompletion ? 'terminated_completion_retry' : 'empty_completion_retry';
                    console.warn(`[${requestId}] ${breadcrumbLog}: ${errMessage}`);
                    pushActivity(requestId, breadcrumb);
                    logEntry.activity.push(breadcrumb);
                }
                console.warn(`[${requestId}] Claude failed (${errMessage}), retrying with ${retryLabel}`);
                pushActivity(requestId, `⚠ Claude failed, retrying with ${retryLabel}`);
                logEntry.activity.push(`⚠ Claude failed: ${errMessage}`);
                isResume = false;
                sessionId = uuidv4();
                logEntry.resumeMethod = wasResume ? 'refresh' : (terminatedCompletion ? 'retry_terminated' : 'retry_empty');
                if (wasResume) {
                    const compactResult = await convertMessagesCompactAsync(messages);
                    promptText = compactResult.promptText;
                    if (compactResult.systemPrompt) {
                        combinedSystemPrompt = `${compactResult.systemPrompt}${toolInstructions}`;
                    }
                    attachmentBlocks = compactResult.attachmentBlocks || [];
                }
                logEntry.promptLen = promptText.length;
                console.log(`[${requestId}] Retry path: new session=${sessionId.slice(0, 8)} promptLen=${promptText.length}`);
                try {
                    ({ text: finalText, usage: finalUsage } = await runClaudeImpl(combinedSystemPrompt, promptText, model, onChunk, ac.signal, reasoning_effort, sessionId, false, attachmentBlocks));
                } catch (retryErr) {
                    console.error(`[${requestId}] Retry also failed: ${retryErr.message}`);
                    logEntry.status = 'error';
                    logEntry.error = retryErr.message;
                    if (isStream) {
                        sendChunk(`\n\n[Error: ${retryErr.message}]`);
                        sendChunk('', 'stop');
                        res.write('data: [DONE]\n\n');
                        res.end();
                    } else {
                        res.status(500).json({ error: { message: retryErr.message, type: 'internal_error' } });
                    }
                    return;
                }
            } else {
                console.error(`[${requestId}] Claude error: ${errMessage}`);
                logEntry.status = 'error';
                logEntry.error = errMessage;
                if (isStream) {
                    sendChunk(`\n\n[Error: ${errMessage}]`);
                    sendChunk('', 'stop');
                    res.write('data: [DONE]\n\n');
                    res.end();
                } else {
                    res.status(500).json({ error: { message: errMessage, type: 'internal_error' } });
                }
                return;
            }
        }

        logEntry.inputTokens = finalUsage.input_tokens;
        logEntry.cacheWriteTokens = finalUsage.cache_creation_tokens;
        logEntry.cacheReadTokens = finalUsage.cache_read_tokens;
        logEntry.outputTokens = finalUsage.output_tokens;
        logEntry.costUsd = finalUsage.cost_usd;

        const usagePayload = buildUsagePayload(finalUsage);

        // Parse <tool_call> blocks from Claude's response. Exact XML is preferred;
        // one unambiguous malformed block can be repaired, but only for declared tools.
        const toolCallResult = parseToolCallsDetailed(finalText || '', { allowedToolNames });
        const toolCalls = toolCallResult.calls;
        if (toolCallResult.repaired) {
            console.warn(`[${requestId}] WARNING malformed_tool_call_repaired close=${toolCallResult.closeTag || 'unknown'} tool=${toolCalls[0]?.name || 'unknown'}`);
        } else if (toolCallResult.hadToolCallMarkup && toolCalls.length === 0) {
            console.warn(`[${requestId}] WARNING malformed_tool_call_unrecoverable reason=${toolCallResult.malformedReason || 'unknown'} preview=${redactSensitivePreview(finalText || '')}`);
        }
        if (toolCallResult.recoveredJson) {
            console.warn(`[${requestId}] WARNING malformed_tool_call_json_recovered`);
        }

        const rawMarkupPresent = hasInternalBridgeMarkup(finalText || '');

        if (toolCalls.length > 0) {
            // Claude requested tools → return as OpenAI tool_calls for OC to execute
            const toolNames = toolCalls.map(tc => tc.name).join(', ');
            console.log(`[${requestId}] → tool_calls: [${toolNames}]`);
            pushActivity(requestId, `→ tool_calls: [${toolNames}]`);
            logEntry.activity.push(`→ tool_calls: [${toolNames}]`);

            // Track tool_call_ids for session reuse
            for (const tc of toolCalls) {
                sessionMap.set(tc.id, { sessionId, createdAt: Date.now() });
            }
            console.log(`[${requestId}] sessionMap: stored ${toolCalls.length} tool_call_ids for session=${sessionId.slice(0, 8)} (total=${sessionMap.size})`);

            if (isStream) {
                writeToolCallsStream(res, completionId, model, toolCalls, usagePayload);
            } else {
                res.json(buildToolCallsNonStream(completionId, model, toolCalls, usagePayload));
            }
        } else {
            // No tool calls — return clean text with finish_reason: stop.
            // Fail closed if raw bridge markup somehow survives parsing.
            let cleanText = cleanResponseText(finalText);
            if (rawMarkupPresent) {
                console.warn(`[${requestId}] WARNING suppressed_internal_bridge_markup preview=${redactSensitivePreview(finalText || '')}`);
                cleanText = '';
            }
            if (cleanText) sendChunk(cleanText);

            if (isStream) {
                writeStopStream(res, completionId, model, usagePayload);
            } else {
                res.json(buildTextNonStream(completionId, model, cleanText, usagePayload));
            }
        }

        // Store channel → CLI session mapping (primary session tracking)
        if (routingKey) {
            const prevEntry = channelMap.get(routingKey);
            channelMap.set(routingKey, {
                sessionId,
                createdAt: prevEntry?.createdAt || Date.now(),
                routingSource,
                lastCompactionHash: logEntry.pendingCompactionHash ?? prevEntry?.lastCompactionHash ?? null,
            });
            if (logEntry.pendingCompactionHash) delete logEntry.pendingCompactionHash;
            console.log(`[${requestId}] channelMap stored: "${routingKey}" → session=${sessionId.slice(0, 8)} (map size=${channelMap.size})`);
        }

        // If this was a new OC session without convLabel (request 1 of /new),
        // store the greeting response so request 2 can link it to the channel.
        // Store response content for future resume detection (fallback for DMs)
        const cleanedForMap = cleanResponseText(finalText);
        const rKey = contentKey(cleanedForMap);
        if (rKey) {
            responseMap.set(rKey, { sessionId, createdAt: Date.now() });
        }

        logEntry.status = 'ok';
        const elapsed = Date.now() - startTime;
        logEntry.durationMs = elapsed;
        console.log(`[${requestId}] done ${elapsed}ms chunks=${chunksSent}`);
        pushActivity(requestId, `✓ done ${(elapsed / 1000).toFixed(1)}s`);

    } catch (err) {
        stats.errors++;
        logEntry.status = 'error';
        logEntry.error = err.message;
        console.error(`[${requestId}] Unhandled:`, err);
        if (!res.headersSent) res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
        else res.end();
    } finally {
        stats.activeRequests = Math.max(0, stats.activeRequests - 1);
        if (acquiredChannel) {
            const cnt = channelActive.get(acquiredChannel) || 0;
            if (cnt <= 1) channelActive.delete(acquiredChannel);
            else channelActive.set(acquiredChannel, cnt - 1);
        }
        logEntry.durationMs = logEntry.durationMs ?? (Date.now() - startTime);
        saveState();
    }
});

module.exports = { app, statusApp, stats, saveState, __setRunClaudeForTests };
