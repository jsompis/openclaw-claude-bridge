'use strict';

// Claude CLI session-file lifecycle on disk.
//
// Claude CLI subprocess runs with cwd=/tmp. On macOS /tmp → /private/tmp,
// so Claude CLI creates sessions in -private-tmp instead of -tmp.
// Use fs.realpathSync to resolve the symlink and match what Claude CLI does.

const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = path.join(
    process.env.HOME,
    '.claude/projects',
    '-' + fs.realpathSync('/tmp').replace(/\//g, '-').replace(/^-/, '')
);
const CLEANUP_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 day

function cleanupSessions(maxAgeMs = CLEANUP_MAX_AGE_MS) {
    try {
        if (!fs.existsSync(SESSIONS_DIR)) return { deleted: 0, remaining: 0 };
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl'));
        const cutoff = Date.now() - maxAgeMs;
        let deleted = 0;
        for (const file of files) {
            const fp = path.join(SESSIONS_DIR, file);
            try {
                const stat = fs.statSync(fp);
                if (stat.mtimeMs < cutoff) { fs.unlinkSync(fp); deleted++; }
            } catch {}
        }
        const remaining = files.length - deleted;
        return { deleted, remaining };
    } catch { return { deleted: 0, remaining: 0, error: 'failed' }; }
}

// Cache session info to avoid sync I/O on every dashboard poll.
let _sessionCache = { data: { count: 0, sizeKB: 0 }, ts: 0 };
function getSessionInfo() {
    if (Date.now() - _sessionCache.ts < 10000) return _sessionCache.data; // 10s TTL
    try {
        if (!fs.existsSync(SESSIONS_DIR)) { _sessionCache = { data: { count: 0, sizeKB: 0 }, ts: Date.now() }; return _sessionCache.data; }
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl'));
        let totalSize = 0;
        for (const file of files) {
            try { totalSize += fs.statSync(path.join(SESSIONS_DIR, file)).size; } catch {}
        }
        _sessionCache = { data: { count: files.length, sizeKB: Math.round(totalSize / 1024) }, ts: Date.now() };
        return _sessionCache.data;
    } catch { return { count: 0, sizeKB: 0 }; }
}

/** Check if a CLI session file still exists on disk. */
function sessionFileExists(sessionId) {
    return fs.existsSync(path.join(SESSIONS_DIR, `${sessionId}.jsonl`));
}

/** Delete a CLI session file from disk. Returns true if a file was unlinked. */
function deleteSessionFile(sessionId) {
    const sessionFile = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
    try {
        if (fs.existsSync(sessionFile)) {
            fs.unlinkSync(sessionFile);
            return true;
        }
    } catch (err) {
        console.warn(`[session] Failed to delete session file ${sessionId}: ${err.message}`);
    }
    return false;
}

// Auto-cleanup on startup (single call, matches the original side effect).
let _startupRan = false;
function runStartupCleanup() {
    if (_startupRan) return;
    _startupRan = true;
    const startupCleanup = cleanupSessions();
    if (startupCleanup.deleted > 0) {
        console.log(`[openclaw-claude-bridge] Startup cleanup: deleted ${startupCleanup.deleted} old sessions, ${startupCleanup.remaining} remaining`);
    }
}

runStartupCleanup();

module.exports = {
    SESSIONS_DIR,
    CLEANUP_MAX_AGE_MS,
    cleanupSessions,
    getSessionInfo,
    sessionFileExists,
    deleteSessionFile,
    runStartupCleanup,
};
