'use strict';

// Bridge in-memory state + JSON persistence.
//
// Owns:
//   - channelMap: routing key → { sessionId, createdAt, routingSource, lastCompactionHash }
//   - sessionMap: tool_call_id → { sessionId, createdAt }
//   - responseMap: 200-char content prefix → { sessionId, createdAt }
//   - channelActive: routing key → in-flight count (for per-channel concurrency limits)
//   - requestLog / globalActivity: circular buffers for the dashboard
//   - stats: aggregate counters surfaced to /status
//
// Persistence is a single state.json next to the repo root, written via
// tmp + rename. saveState is called by the request finally block; loadState
// runs once on import.

const fs = require('fs');
const path = require('path');

const { sessionFileExists, deleteSessionFile } = require('./session-cleanup');
const { clearSessionAlias } = require('./claude');

const STATE_FILE = path.join(__dirname, '..', 'state.json');

// Circular buffers
const MAX_LOG = 200;
const MAX_ACTIVITY = 50;

// Memory cleanup TTL (not for session lifecycle — just garbage collection)
const MEMORY_GC_TTL_MS = 60 * 60 * 1000; // 1 hour

// ResponseMap is only a best-effort fallback. Avoid short/sentinel replies that
// commonly collide across unrelated sessions (NO_REPLY, HEARTBEAT_OK, etc.).
const RESPONSE_MAP_MIN_CHARS = 50;
const RESPONSE_MAP_KEY_MAX_CHARS = 200;
const RESPONSE_MAP_SENTINELS = new Set(['NO_REPLY', 'HEARTBEAT_OK', '[DONE]']);

// Concurrency limits
const MAX_PER_CHANNEL = parseInt(process.env.MAX_PER_CHANNEL) || 2;
const MAX_GLOBAL = parseInt(process.env.MAX_GLOBAL) || 20;

// --- In-memory state ---
const stats = {
    startedAt: new Date(),
    totalRequests: 0,
    activeRequests: 0,
    lastRequestAt: null,
    lastModel: null,
    errors: 0,
};

const channelMap = new Map();   // routing key → { sessionId, createdAt, routingSource, lastCompactionHash }
const sessionMap = new Map();   // tool_call_id → { sessionId, createdAt }
const responseMap = new Map();  // first-200-chars → { sessionId, createdAt }
const channelActive = new Map(); // routing key → in-flight count

const requestLog = [];
const globalActivity = [];

function pushLog(entry) {
    requestLog.push(entry);
    if (requestLog.length > MAX_LOG) requestLog.shift();
}

function pushActivity(requestId, msg) {
    globalActivity.push({ id: requestId, at: Date.now(), msg });
    if (globalActivity.length > MAX_ACTIVITY) globalActivity.shift();
}

/** Normalize text before deciding whether it is safe as a responseMap key. */
function normalizeResponseMapText(text) {
    if (typeof text !== 'string') return null;
    const normalized = text.trim().replace(/\s+/g, ' ');
    return normalized || null;
}

/** Whether text is distinctive enough for responseMap fallback routing. */
function isResponseMapEligible(text) {
    const normalized = normalizeResponseMapText(text);
    if (!normalized) return false;
    if (RESPONSE_MAP_SENTINELS.has(normalized.toUpperCase())) return false;
    if (normalized.length < RESPONSE_MAP_MIN_CHARS) return false;
    if (!/[\p{L}\p{N}]/u.test(normalized)) return false;
    return true;
}

/** Safe first 200 chars of normalized text as a lookup key. */
function contentKey(text) {
    const normalized = normalizeResponseMapText(text);
    if (!isResponseMapEligible(normalized)) return null;
    return normalized.slice(0, RESPONSE_MAP_KEY_MAX_CHARS);
}

/** Garbage-collect orphaned in-memory entries older than MEMORY_GC_TTL_MS. */
function gcMemory() {
    const cutoff = Date.now() - MEMORY_GC_TTL_MS;
    for (const [key, val] of sessionMap) {
        if (val.createdAt < cutoff) sessionMap.delete(key);
    }
    for (const [key, val] of responseMap) {
        if (val.createdAt < cutoff) responseMap.delete(key);
    }
}

/**
 * Clean up all in-memory entries belonging to a specific CLI session.
 * Also delete the CLI session file from disk.
 */
function purgeCliSession(cliSessionId) {
    clearSessionAlias(cliSessionId);
    for (const [key, val] of sessionMap) {
        if (val.sessionId === cliSessionId) sessionMap.delete(key);
    }
    for (const [key, val] of responseMap) {
        if (val.sessionId === cliSessionId) responseMap.delete(key);
    }
    const deleted = deleteSessionFile(cliSessionId);
    if (deleted) {
        console.log(`[session] Purged old CLI session file: ${cliSessionId}`);
    }
}

// --- Persistence ---
function saveState() {
    try {
        const data = {
            stats: { totalRequests: stats.totalRequests, errors: stats.errors },
            channelMap: Array.from(channelMap.entries()),
            responseMap: Array.from(responseMap.entries()),
            requestLog,
            globalActivity,
        };
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, STATE_FILE);
    } catch (err) {
        console.warn(`[persist] Failed to save state: ${err.message}`);
    }
}

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) return;
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

        if (data.stats) {
            stats.totalRequests = data.stats.totalRequests || 0;
            stats.errors = data.stats.errors || 0;
        }

        let restored = 0, pruned = 0;
        if (data.channelMap) {
            for (const [key, val] of data.channelMap) {
                if (sessionFileExists(val.sessionId)) {
                    channelMap.set(key, val);
                    restored++;
                } else {
                    pruned++;
                }
            }
        }

        if (data.responseMap) {
            for (const [key, val] of data.responseMap) {
                const safeKey = contentKey(key);
                if (safeKey && sessionFileExists(val.sessionId)) {
                    responseMap.set(safeKey, val);
                }
            }
        }

        if (data.requestLog) {
            requestLog.push(...data.requestLog.slice(-MAX_LOG));
        }

        if (data.globalActivity) {
            globalActivity.push(...data.globalActivity.slice(-MAX_ACTIVITY));
        }

        console.log(`[persist] Loaded: ${restored} channels, ${pruned} pruned (session gone), ${requestLog.length} log entries, ${globalActivity.length} activity`);
    } catch (err) {
        console.warn(`[persist] Failed to load state: ${err.message}`);
    }
}

loadState();

module.exports = {
    STATE_FILE,
    MAX_LOG,
    MAX_ACTIVITY,
    MEMORY_GC_TTL_MS,
    MAX_PER_CHANNEL,
    MAX_GLOBAL,
    stats,
    channelMap,
    sessionMap,
    responseMap,
    channelActive,
    requestLog,
    globalActivity,
    pushLog,
    pushActivity,
    contentKey,
    isResponseMapEligible,
    gcMemory,
    purgeCliSession,
    saveState,
    loadState,
};
