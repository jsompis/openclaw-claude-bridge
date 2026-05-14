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

const STATE_SCHEMA_VERSION = 1;
const STATE_DIR = process.env.OPENCLAW_BRIDGE_STATE_DIR || path.join(__dirname, '..');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

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
function isPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function isSessionBackedEntry(entry) {
    return Array.isArray(entry)
        && entry.length >= 2
        && typeof entry[0] === 'string'
        && isPlainObject(entry[1])
        && typeof entry[1].sessionId === 'string'
        && sessionFileExists(entry[1].sessionId);
}

function loadBoundedArray(target, value, max) {
    if (!Array.isArray(value)) return;
    target.push(...value.slice(-max));
}

function saveState() {
    try {
        const data = {
            schemaVersion: STATE_SCHEMA_VERSION,
            stats: { totalRequests: stats.totalRequests, errors: stats.errors },
            channelMap: Array.from(channelMap.entries()),
            sessionMap: Array.from(sessionMap.entries()),
            responseMap: Array.from(responseMap.entries()),
            requestLog,
            globalActivity,
        };
        fs.mkdirSync(STATE_DIR, { recursive: true });
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
        if (!isPlainObject(data)) {
            console.warn('[persist] Failed to load state: state.json root is not an object');
            return;
        }

        if (data.schemaVersion === undefined) {
            console.warn('[persist] Loading legacy unversioned state');
        } else if (data.schemaVersion !== STATE_SCHEMA_VERSION) {
            console.warn(`[persist] Unknown state schemaVersion ${data.schemaVersion}; loading compatible fields only`);
        }

        if (isPlainObject(data.stats)) {
            stats.totalRequests = data.stats.totalRequests || 0;
            stats.errors = data.stats.errors || 0;
        }

        let restored = 0, sessionRestored = 0, pruned = 0, responseRestored = 0, responsePruned = 0;
        if (Array.isArray(data.channelMap)) {
            for (const entry of data.channelMap) {
                if (isSessionBackedEntry(entry)) {
                    const [key, val] = entry;
                    channelMap.set(key, val);
                    restored++;
                } else {
                    pruned++;
                }
            }
        }

        if (Array.isArray(data.sessionMap)) {
            for (const entry of data.sessionMap) {
                if (isSessionBackedEntry(entry)) {
                    const [key, val] = entry;
                    sessionMap.set(key, val);
                    sessionRestored++;
                }
            }
        }

        if (Array.isArray(data.responseMap)) {
            for (const entry of data.responseMap) {
                if (!Array.isArray(entry) || entry.length < 2) {
                    responsePruned++;
                    continue;
                }
                const [key, val] = entry;
                const safeKey = contentKey(key);
                if (safeKey && isPlainObject(val) && typeof val.sessionId === 'string' && sessionFileExists(val.sessionId)) {
                    responseMap.set(safeKey, val);
                    responseRestored++;
                } else {
                    responsePruned++;
                }
            }
        }

        loadBoundedArray(requestLog, data.requestLog, MAX_LOG);
        loadBoundedArray(globalActivity, data.globalActivity, MAX_ACTIVITY);

        console.log(`[persist] Loaded schema=${data.schemaVersion || 'legacy'}: ${restored} channels, ${sessionRestored} sessions, ${responseRestored} responses, ${pruned + responsePruned} pruned, ${requestLog.length} log entries, ${globalActivity.length} activity`);
    } catch (err) {
        console.warn(`[persist] Failed to load state: ${err.message}`);
    }
}

loadState();

module.exports = {
    STATE_SCHEMA_VERSION,
    STATE_DIR,
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
