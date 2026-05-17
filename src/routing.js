'use strict';

// Routing helpers for resolving an inbound /v1/chat/completions request to a
// stable Claude CLI session.
//
// Six identifiers are inspected, in priority order. Trusted transport/context
// signals intentionally outrank user-visible prompt metadata so a spoofed
// "Conversation info" block cannot override a stable OpenClaw route:
//   1. openclawSessionKey  — x-openclaw-session-key HTTP header. Stable for
//      transports that forward custom headers.
//   2. inboundContext    — "Inbound Context (trusted metadata)" JSON block in
//      the system prompt; used when transports drop custom headers.
//   3. conversationLabel — JSON block "Conversation info (untrusted metadata)"
//      embedded by OpenClaw in user/developer/system text. Legacy fallback for
//      older channel metadata when no trusted route signal is present.
//   4. promptCacheKey    — req.body.prompt_cache_key (OpenAI-style). OpenClaw
//      attaches the agent session id here, so subagent/cron sessions stay
//      stable across turns.
//   5. cronContext       — "[cron:<uuid> <jobName>]" prefix at the start of the
//      user message. OpenClaw cron isolated runs do not forward routing
//      identity; this structured prefix is a bridge-side fallback so cron
//      tool-call follow-ups can resume the same Claude CLI session instead of
//      spawning a fresh one per turn.
//   6. openAiUser        — req.body.user. Final fallback for raw OpenAI
//      clients.
//
// Without any of these, every turn would create a fresh Claude CLI session.

function headerValue(value) {
    if (Array.isArray(value)) return value.find(v => typeof v === 'string' && v.trim())?.trim() || null;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function messageContentText(msg) {
    return typeof msg.content === 'string' ? msg.content
        : Array.isArray(msg.content) ? msg.content.filter(p => p && (p.type === 'text' || typeof p.text === 'string')).map(p => p.text || '').join('\n')
        : '';
}

function messageText(msg) {
    if (!msg) return '';
    return messageContentText(msg);
}

/**
 * Extract OC conversation label from messages.
 * Looks for "Conversation info (untrusted metadata)" JSON block in text-bearing
 * user/developer/system messages. Returns the conversation_label string, or null
 * if not found (e.g. DMs).
 */
function extractConversationLabel(messages) {
    for (const msg of messages) {
        if (!['user', 'developer', 'system'].includes(msg.role)) continue;
        const content = messageContentText(msg);
        const match = content.match(/Conversation info \(untrusted metadata\):\s*```json\s*(\{[\s\S]*?\})\s*```/);
        if (match) {
            try {
                const meta = JSON.parse(match[1]);
                return meta.conversation_label || (meta.sender ? `dm:${meta.sender}` : null);
            } catch {}
        }
    }
    return null;
}

/**
 * Extract stable OpenClaw inbound identity from the system/developer context.
 * Recent OpenClaw requests may omit the older Conversation info block and do
 * not forward x-openclaw-session-key to custom OpenAI-compatible providers.
 * The trusted inbound metadata block is still present in prompt context, so use
 * it as a bridge-owned fallback instead of starting a fresh Claude session.
 */
function extractInboundContext(messages) {
    for (const msg of messages) {
        if (!['user', 'developer', 'system'].includes(msg.role)) continue;
        const content = messageContentText(msg);
        const match = content.match(/Inbound Context \(trusted metadata\)[\s\S]*?```json\s*(\{[\s\S]*?\})\s*```/);
        if (!match) continue;
        try {
            const meta = JSON.parse(match[1]);
            const channel = typeof meta.channel === 'string' && meta.channel.trim() ? meta.channel.trim() : null;
            const chatType = typeof meta.chat_type === 'string' && meta.chat_type.trim() ? meta.chat_type.trim() : null;
            const account = typeof meta.account_id === 'string' && meta.account_id.trim() ? meta.account_id.trim() : null;
            const provider = typeof meta.provider === 'string' && meta.provider.trim() ? meta.provider.trim() : null;
            const surface = typeof meta.surface === 'string' && meta.surface.trim() ? meta.surface.trim() : null;
            const parts = [channel || provider || surface, chatType, account].filter(Boolean);
            const label = parts.length ? parts.join(':') : null;
            return { label, channel, chatType, account, provider, surface };
        } catch {}
    }
    return null;
}

/**
 * Extract agent name from developer/system messages.
 * OC includes the agent's IDENTITY.md in the system prompt, which contains
 * "**Name:** AgentName". Returns the agent name string, or null if not found.
 */
function extractAgentName(messages) {
    for (const msg of messages) {
        if (msg.role !== 'developer' && msg.role !== 'system') continue;
        const text = messageContentText(msg);
        const match = text.match(/\*\*Name:\*\*\s*(.+)/);
        if (match) {
            const name = match[1].trim();
            if (name && !name.startsWith('_')) return name;
        }
    }
    return null;
}

/**
 * Extract OpenClaw cron-runtime context from the user message.
 * OpenClaw cron isolated runs prepend a structured "[cron:<jobId> <jobName>]"
 * marker to the user message because they do not forward any other routing
 * identity (no x-openclaw-session-key, no Inbound Context, no prompt_cache_key,
 * no user). This bridge-side fallback recovers a stable routing key so cron
 * tool-call follow-ups can resume the same Claude CLI session within a job
 * instead of spawning a fresh one per turn.
 *
 * The regex is anchored to the START of the user message text and requires a
 * UUID-shaped jobId (at least 8 hex/dash chars) so untrusted prose containing
 * the substring "[cron:..." mid-message will NOT trigger routing.
 */
function extractCronContext(messages) {
    for (const msg of messages) {
        if (msg.role !== 'user') continue;
        const content = messageContentText(msg);
        const match = content.match(/^\[cron:([0-9a-fA-F][0-9a-fA-F-]{7,})\s+([^\]\s][^\]]*)\]/);
        if (!match) continue;
        const jobId = match[1].trim();
        const jobName = match[2].trim();
        if (!jobId || !jobName) continue;
        return { jobId, jobName, label: `${jobId}:${jobName}` };
    }
    return null;
}

function debugRawRequest(requestId, req, messages) {
    if (process.env.CLAUDE_BRIDGE_DEBUG_RAW_REQUEST !== '1') return;
    try {
        const headers = {};
        for (const key of ['x-openclaw-session-key', 'user-agent', 'content-type']) {
            if (req.headers[key]) headers[key] = headerValue(req.headers[key]) || String(req.headers[key]);
        }
        const body = req.body || {};
        const sample = {
            headers,
            model: typeof body.model === 'string' ? body.model.slice(0, 120) : null,
            stream: typeof body.stream === 'boolean' ? body.stream : null,
            topLevelKeys: Object.keys(body).sort(),
            reasoning_effort: body.reasoning_effort ?? null,
            reasoningEffort: body.reasoningEffort ?? null,
            reasoning: body.reasoning ?? null,
            thinking: body.thinking ?? null,
            thought_level: body.thought_level ?? null,
            user: typeof body.user === 'string' ? body.user.slice(0, 120) : null,
            prompt_cache_key: typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key.slice(0, 120) : null,
            messages: (messages || []).slice(0, 6).map((m) => ({
                role: m.role,
                text: messageContentText(m).slice(0, 500),
            })),
        };
        console.warn(`[${requestId}] DEBUG_RAW_REQUEST ${JSON.stringify(sample)}`);
    } catch (err) {
        console.warn(`[${requestId}] DEBUG_RAW_REQUEST failed: ${err?.message || err}`);
    }
}

/**
 * Inspect a request and surface all routing signals at once. Pure function:
 * does not mutate req/body. Callers (main path and memflush path) decide
 * which signals to use via pickRouting().
 */
function extractRoutingSignals({ req, body, messages }) {
    const ocSessionKey = req ? headerValue(req.headers['x-openclaw-session-key']) : null;
    const convLabel = extractConversationLabel(messages);
    const inboundContext = extractInboundContext(messages);
    const inboundLabel = inboundContext?.label || null;
    const agentName = extractAgentName(messages);
    const openAiUser = body && typeof body.user === 'string' && body.user.trim() ? body.user.trim() : null;
    const promptCacheKey = body && typeof body.prompt_cache_key === 'string' && body.prompt_cache_key.trim() ? body.prompt_cache_key.trim() : null;
    const cronContext = extractCronContext(messages);
    return { ocSessionKey, convLabel, inboundContext, inboundLabel, agentName, openAiUser, promptCacheKey, cronContext };
}

// Default priority used by the main /v1/chat/completions handler.
// cronContext is a structured fallback that sits between promptCacheKey and
// the loose openAiUser tail. Trusted/headers/inboundContext/conversationLabel/
// promptCacheKey still win first so cron prefix can never override a real
// routing identity.
const MAIN_PRIORITY = ['openclawSessionKey', 'inboundContext', 'conversationLabel', 'promptCacheKey', 'cronContext', 'openAiUser'];
// Memflush path still skips openclawSessionKey routing, but trusted inbound
// context outranks the legacy untrusted conversation block.
const MEMFLUSH_PRIORITY = ['inboundContext', 'conversationLabel', 'promptCacheKey', 'cronContext', 'openAiUser'];

/**
 * Pick the active routingSource/routingLabel/routingKey/displayChannel from a
 * set of signals, following a priority order. Used from both the main request
 * handler and the memflush interceptor so the two paths cannot drift.
 */
function pickRouting(signals, priority = MAIN_PRIORITY) {
    const { ocSessionKey, convLabel, inboundContext, inboundLabel, agentName, openAiUser, promptCacheKey, cronContext } = signals;
    let routingSource = null;
    let routingLabel = null;
    for (const source of priority) {
        if (source === 'conversationLabel' && convLabel) {
            routingSource = 'conversationLabel';
            routingLabel = agentName ? `${convLabel}::${agentName}` : convLabel;
            break;
        }
        if (source === 'openclawSessionKey' && ocSessionKey) {
            routingSource = 'openclawSessionKey';
            routingLabel = ocSessionKey;
            break;
        }
        if (source === 'inboundContext' && inboundLabel) {
            routingSource = 'inboundContext';
            routingLabel = agentName ? `${inboundLabel}::${agentName}` : inboundLabel;
            break;
        }
        if (source === 'promptCacheKey' && promptCacheKey) {
            routingSource = 'promptCacheKey';
            routingLabel = promptCacheKey;
            break;
        }
        if (source === 'cronContext' && cronContext) {
            routingSource = 'cronContext';
            routingLabel = cronContext.label;
            break;
        }
        if (source === 'openAiUser' && openAiUser) {
            routingSource = 'openAiUser';
            routingLabel = openAiUser;
            break;
        }
    }
    const routingKey = routingLabel ? `${routingSource}:${routingLabel}` : null;

    let displayChannel = null;
    if (routingSource === 'conversationLabel') {
        displayChannel = convLabel;
    } else if (routingSource === 'openclawSessionKey') {
        displayChannel = `session:${ocSessionKey}`;
    } else if (routingSource === 'inboundContext') {
        displayChannel = inboundContext?.channel || inboundLabel;
    } else if (routingSource === 'promptCacheKey') {
        displayChannel = `session:${promptCacheKey}`;
    } else if (routingSource === 'cronContext') {
        displayChannel = `cron:${cronContext.jobName}`;
    } else if (routingSource === 'openAiUser') {
        displayChannel = `user:${openAiUser}`;
    }

    return { routingSource, routingLabel, routingKey, displayChannel };
}

module.exports = {
    headerValue,
    messageContentText,
    messageText,
    extractConversationLabel,
    extractInboundContext,
    extractAgentName,
    extractCronContext,
    debugRawRequest,
    extractRoutingSignals,
    pickRouting,
    MAIN_PRIORITY,
    MEMFLUSH_PRIORITY,
};
