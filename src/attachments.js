'use strict';

/**
 * Attachment handling for OpenClaw Claude Bridge.
 *
 * Claude Code CLI does NOT support @/path image references in text-mode stdin
 * (--print without --input-format stream-json) — it interprets them as a request
 * to use the (disabled) Read tool. The path that works is:
 *
 *   1. Pass --input-format stream-json --output-format stream-json --verbose
 *   2. Feed stdin a JSON message in Anthropic Messages API shape:
 *        {type: "user", message: {role: "user", content: [
 *          {type: "text", text: "..."},
 *          {type: "image", source: {type: "base64", media_type: "image/png", data: "..."}},
 *          {type: "document", source: {type: "base64", media_type: "application/pdf", data: "..."}},
 *        ]}}
 *
 * Verified against Claude CLI v2.1.98 with both Haiku and Sonnet — image content
 * was correctly identified end-to-end. Originally implemented in
 * Kyzcreig/hermes-claude-bridge v0.1.0; ported here with env-var rename.
 *
 * This module:
 *   - inspects OpenAI content parts for non-text attachments
 *   - returns a structured payload the runClaude path uses to choose
 *     text-mode (no attachments, fast path) vs stream-json input mode
 *
 * Modes (controlled by env OPENCLAW_BRIDGE_ATTACHMENT_MODE):
 *   - "passthrough" (default): emit Anthropic content blocks via stream-json input
 *   - "describe": drop non-text parts entirely (caller is expected to have
 *     described them upstream, e.g. via OpenClaw's imageModel routing).
 *     Use this if you want to preserve the historical bridge behavior.
 *
 * Set OPENCLAW_BRIDGE_ATTACHMENT_MODE=describe to turn off native multimodal.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const MODE = process.env.OPENCLAW_BRIDGE_ATTACHMENT_MODE || 'passthrough';
const PER_TURN_CAP = parseInt(process.env.OPENCLAW_BRIDGE_ATTACHMENT_PER_TURN_CAP) || 20;
const SESSION_BUDGET_MB = parseInt(process.env.OPENCLAW_BRIDGE_ATTACHMENT_SESSION_BUDGET_MB) || 500;
const DOWNLOAD_TIMEOUT_MS = parseInt(process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS) || 30000;
const DOWNLOAD_MAX_BYTES = parseInt(process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_MAX_BYTES) || 50 * 1024 * 1024;

// State dir for staging attachment bytes. OC bridge has no formal state dir
// convention; default to <repo>/state/attachments unless OPENCLAW_BRIDGE_STATE_DIR
// is set explicitly.
const STATE_DIR = process.env.OPENCLAW_BRIDGE_STATE_DIR
    || path.join(__dirname, '..', 'state');
const ATTACH_DIR = path.join(STATE_DIR, 'attachments');

try { fs.mkdirSync(ATTACH_DIR, { recursive: true }); } catch {}

class AttachmentBudgetError extends Error {
    constructor(message) { super(message); this.name = 'AttachmentBudgetError'; }
}

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
const DOC_MIMES = new Set(['application/pdf']);  // CLI accepts PDF as "document"

function _checkSessionBudget() {
    try {
        const files = fs.readdirSync(ATTACH_DIR);
        let total = 0;
        for (const f of files) {
            try { total += fs.statSync(path.join(ATTACH_DIR, f)).size; } catch {}
        }
        const budgetBytes = SESSION_BUDGET_MB * 1024 * 1024;
        if (total > budgetBytes) {
            throw new AttachmentBudgetError(
                `session disk budget exceeded (${Math.round(total/1024/1024)} MB > ${SESSION_BUDGET_MB} MB)`
            );
        }
    } catch (err) {
        if (err instanceof AttachmentBudgetError) throw err;
    }
}

function _safeExt(name, fallback = 'bin') {
    if (!name) return fallback;
    const m = name.match(/\.([a-zA-Z0-9]{1,8})$/);
    return m ? m[1].toLowerCase() : fallback;
}

function _extFromMime(mime) {
    if (!mime) return null;
    const map = {
        'image/png': 'png',
        'image/jpeg': 'jpg', 'image/jpg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'application/pdf': 'pdf',
        'text/plain': 'txt',
        'text/markdown': 'md',
        'application/json': 'json',
    };
    return map[mime.toLowerCase()] || null;
}

function _mimeFromExt(ext) {
    const map = {
        'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
        'webp': 'image/webp', 'gif': 'image/gif',
        'pdf': 'application/pdf',
        'txt': 'text/plain', 'md': 'text/markdown', 'json': 'application/json',
        'py': 'text/x-python', 'js': 'text/javascript', 'ts': 'text/typescript',
    };
    return map[(ext || '').toLowerCase()] || 'application/octet-stream';
}

function _cleanMime(mime) {
    if (!mime || typeof mime !== 'string') return null;
    return mime.split(';', 1)[0].trim().toLowerCase() || null;
}

function _parseDataUrl(url) {
    const m = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!m) return null;
    const mime = m[1] || 'application/octet-stream';
    const isBase64 = !!m[2];
    const payload = m[3];
    const buf = isBase64
        ? Buffer.from(payload, 'base64')
        : Buffer.from(decodeURIComponent(payload), 'utf8');
    return { mime, buf };
}

function _expandHome(inputPath) {
    if (typeof inputPath !== 'string') return inputPath;
    if (!inputPath.startsWith('~')) return inputPath;
    const home = process.env.HOME;
    if (!home) return inputPath;
    return path.join(home, inputPath.slice(1));
}

function resolveForPolicy(inputPath) {
    const expanded = _expandHome(inputPath);
    const resolved = path.resolve(expanded);
    try {
        return fs.realpathSync(resolved);
    } catch {
        return resolved;
    }
}

function parseAttachmentRoots() {
    const raw = process.env.OPENCLAW_BRIDGE_ATTACHMENT_ROOTS || '';
    return raw
        .split(':')
        .map(s => s.trim())
        .filter(Boolean)
        .map(resolveForPolicy);
}

function isPathAllowed(absPath, roots) {
    for (const root of roots) {
        const rel = path.relative(root, absPath);
        if (rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel))) {
            return true;
        }
    }
    return false;
}

function _resolveAllowedLocalPath(inputPath) {
    const roots = parseAttachmentRoots();
    if (!roots.length) {
        console.warn(`[attachments] local file path rejected (no allowlist): ${inputPath}`);
        return null;
    }
    const policyPath = resolveForPolicy(inputPath);
    if (!isPathAllowed(policyPath, roots)) {
        console.warn(`[attachments] local file path rejected (outside allowlist): ${inputPath}`);
        return null;
    }
    return policyPath;
}

function _isRemoteUrl(url) {
    return /^https?:\/\//i.test(url || '');
}

function _nameFromUrl(url) {
    try {
        const name = path.basename(new URL(url).pathname);
        return name || null;
    } catch {
        return null;
    }
}

async function _download(url) {
    if (typeof fetch !== 'function') {
        throw new Error('remote attachment downloads require global fetch');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });

        if (!response.ok) {
            throw new Error(`download failed: HTTP ${response.status}`);
        }

        const contentLength = Number(response.headers.get('content-length') || 0);
        if (contentLength > DOWNLOAD_MAX_BYTES) {
            throw new Error(`download exceeded max bytes (${contentLength} > ${DOWNLOAD_MAX_BYTES})`);
        }

        const mime = _cleanMime(response.headers.get('content-type'));
        const body = response.body;
        if (body && typeof body.getReader === 'function') {
            const reader = body.getReader();
            const chunks = [];
            let total = 0;
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = Buffer.from(value);
                    total += chunk.length;
                    if (total > DOWNLOAD_MAX_BYTES) {
                        try { await reader.cancel(); } catch {}
                        throw new Error(`download exceeded max bytes (${total} > ${DOWNLOAD_MAX_BYTES})`);
                    }
                    chunks.push(chunk);
                }
            } finally {
                try { reader.releaseLock(); } catch {}
            }
            return { buf: Buffer.concat(chunks, total), mime };
        }

        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > DOWNLOAD_MAX_BYTES) {
            throw new Error(`download exceeded max bytes (${arrayBuffer.byteLength} > ${DOWNLOAD_MAX_BYTES})`);
        }
        return { buf: Buffer.from(arrayBuffer), mime };
    } catch (err) {
        if (err?.name === 'AbortError') {
            throw new Error(`download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`);
        }
        if (/^download (?:failed|exceeded)/.test(err?.message || '')) {
            throw err;
        }
        throw new Error(`download failed: ${err.message}`);
    } finally {
        clearTimeout(timeout);
    }
}

function _resolveLocalOrDataUrl(url) {
    if (url.startsWith('data:')) {
        const parsed = _parseDataUrl(url);
        if (!parsed) return null;
        return { bytes: parsed.buf, mime: parsed.mime, name: null };
    }
    if (url.startsWith('/') || url.startsWith('~') || url.startsWith('./')) {
        const abs = _resolveAllowedLocalPath(url);
        if (!abs) return null;
        if (!fs.existsSync(abs)) return null;
        return {
            bytes: fs.readFileSync(abs),
            name: path.basename(abs),
            mime: _mimeFromExt(_safeExt(abs)),
        };
    }
    return null;
}

function _finalizeImageAttachment(resolved) {
    if (!resolved) return null;
    let { bytes, mime, name } = resolved;
    if (!IMAGE_MIMES.has((mime || '').toLowerCase())) {
        const fromName = _mimeFromExt(_safeExt(name));
        if (IMAGE_MIMES.has(fromName)) mime = fromName;
        else mime = mime || 'image/png';  // best-effort default
    }
    return { bytes, mime, name };
}

/**
 * Resolve an OpenAI content part to {bytes, mime, name} or null if not an
 * attachment we handle. Used by classifyPartsAsync() to build Anthropic content
 * blocks.
 */
async function _resolveAttachment(part) {
    if (part.type === 'image_url' || part.type === 'input_image') {
        const v = part.image_url;
        const url = typeof v === 'string' ? v : (v && v.url);
        if (!url) return null;

        if (_isRemoteUrl(url)) {
            const { buf, mime } = await _download(url);
            return _finalizeImageAttachment({ bytes: buf, mime, name: _nameFromUrl(url) });
        }
        return _finalizeImageAttachment(_resolveLocalOrDataUrl(url));
    }

    if (part.type === 'file') {
        const f = part.file || {};
        let name = f.filename || f.name || null;
        let bytes = null;
        let mime = null;
        if (f.file_data) {
            try { bytes = Buffer.from(f.file_data, 'base64'); } catch { return null; }
        } else if (f.file_url) {
            if (_isRemoteUrl(f.file_url)) {
                const downloaded = await _download(f.file_url);
                bytes = downloaded.buf;
                mime = downloaded.mime;
                if (!name) name = _nameFromUrl(f.file_url);
            } else {
                const resolved = _resolveLocalOrDataUrl(f.file_url);
                if (!resolved) return null;
                bytes = resolved.bytes;
                mime = resolved.mime;
                if (!name) name = resolved.name;
            }
        } else if (f.path) {
            const abs = _resolveAllowedLocalPath(f.path);
            if (!abs) return null;
            if (!fs.existsSync(abs)) return null;
            bytes = fs.readFileSync(abs);
            if (!name) name = path.basename(abs);
        } else {
            return null;
        }
        const ext = _safeExt(name);
        mime = mime || _mimeFromExt(ext);
        return { bytes, mime, name };
    }

    return null;
}

function _resolveAttachmentSync(part) {
    if (part.type === 'image_url' || part.type === 'input_image') {
        const v = part.image_url;
        const url = typeof v === 'string' ? v : (v && v.url);
        if (!url) return null;
        if (_isRemoteUrl(url)) {
            throw new Error('remote downloads require async path');
        }
        return _finalizeImageAttachment(_resolveLocalOrDataUrl(url));
    }

    if (part.type === 'file') {
        const f = part.file || {};
        let name = f.filename || f.name || null;
        let bytes = null;
        let mime = null;
        if (f.file_data) {
            try { bytes = Buffer.from(f.file_data, 'base64'); } catch { return null; }
        } else if (f.file_url) {
            if (_isRemoteUrl(f.file_url)) {
                throw new Error('remote downloads require async path');
            }
            const resolved = _resolveLocalOrDataUrl(f.file_url);
            if (!resolved) return null;
            bytes = resolved.bytes;
            mime = resolved.mime;
            if (!name) name = resolved.name;
        } else if (f.path) {
            const abs = _resolveAllowedLocalPath(f.path);
            if (!abs) return null;
            if (!fs.existsSync(abs)) return null;
            bytes = fs.readFileSync(abs);
            if (!name) name = path.basename(abs);
        } else {
            return null;
        }
        const ext = _safeExt(name);
        mime = mime || _mimeFromExt(ext);
        return { bytes, mime, name };
    }

    return null;
}

function _appendResolved({ resolved, attachments, textSegments, turnId, count }) {
    const { bytes, mime, name } = resolved;

    // Image → Anthropic image block
    if (IMAGE_MIMES.has((mime || '').toLowerCase())) {
        attachments.push({
            type: 'image',
            source: {
                type: 'base64',
                media_type: mime,
                data: bytes.toString('base64'),
            },
        });
        return;
    }
    // PDF → Anthropic document block
    if (DOC_MIMES.has((mime || '').toLowerCase())) {
        attachments.push({
            type: 'document',
            source: {
                type: 'base64',
                media_type: mime,
                data: bytes.toString('base64'),
            },
        });
        return;
    }
    // Text/code file → inline as fenced block in the text segment.
    // Cheap, lossless for the use cases (configs, source files, logs).
    // Also persist the file to state/attachments/ for debugging.
    try {
        const ext = _extFromMime(mime) || _safeExt(name, 'txt');
        const slug = `${turnId}-${count}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
        fs.writeFileSync(path.join(ATTACH_DIR, slug), bytes);
    } catch {}
    const lang = _safeExt(name, '');
    const asText = bytes.toString('utf8');
    const displayName = name || `attachment.${_extFromMime(mime) || 'bin'}`;
    textSegments.push(
        `\n[attached file: ${displayName}]\n\`\`\`${lang}\n${asText}\n\`\`\`\n`
    );
}

/**
 * Given an OpenAI message's content (string or array of parts), classify it
 * into:
 *   - {text: string, attachments: [Anthropic content blocks]}
 *
 * In "passthrough" mode:
 *   - images → Anthropic image content blocks (base64)
 *   - PDFs → Anthropic document content blocks (base64)
 *   - other files (text/code) → inlined as fenced code blocks in the text segment
 *
 * In "describe" mode: all non-text parts are dropped (preserves legacy
 * imageModel-routing behavior).
 *
 * The caller decides whether the resulting message needs stream-json input
 * (has attachments) or can use plain text mode (no attachments).
 */
function classifyParts(content, turnId) {
    if (typeof content === 'string') {
        return { text: content, attachments: [] };
    }
    if (content === null || content === undefined) {
        return { text: '', attachments: [] };
    }
    if (!Array.isArray(content)) {
        return { text: String(content ?? ''), attachments: [] };
    }

    const textSegments = [];
    const attachments = [];
    let count = 0;

    for (const p of content) {
        if (!p || typeof p !== 'object') continue;
        if (p.type === 'text') {
            if (p.text) textSegments.push(p.text);
            continue;
        }
        if (MODE === 'describe') continue;

        if (++count > PER_TURN_CAP) {
            throw new AttachmentBudgetError(
                `per-turn cap exceeded (${count} > ${PER_TURN_CAP})`
            );
        }
        _checkSessionBudget();

        let resolved;
        try {
            resolved = _resolveAttachmentSync(p);
        } catch (err) {
            console.warn(`[attachments] resolve failed: ${err.message}`);
            textSegments.push(`[attachment skipped: ${err.message}]`);
            continue;
        }
        if (!resolved) {
            textSegments.push('[attachment skipped: unrecognized format]');
            continue;
        }
        _appendResolved({ resolved, attachments, textSegments, turnId, count });
    }

    return {
        text: textSegments.join('\n'),
        attachments,
    };
}

async function classifyPartsAsync(content, turnId) {
    if (typeof content === 'string') {
        return { text: content, attachments: [] };
    }
    if (content === null || content === undefined) {
        return { text: '', attachments: [] };
    }
    if (!Array.isArray(content)) {
        return { text: String(content ?? ''), attachments: [] };
    }

    const textSegments = [];
    const attachments = [];
    let count = 0;

    for (const p of content) {
        if (!p || typeof p !== 'object') continue;
        if (p.type === 'text') {
            if (p.text) textSegments.push(p.text);
            continue;
        }
        if (MODE === 'describe') continue;

        if (++count > PER_TURN_CAP) {
            throw new AttachmentBudgetError(
                `per-turn cap exceeded (${count} > ${PER_TURN_CAP})`
            );
        }
        _checkSessionBudget();

        let resolved;
        try {
            resolved = await _resolveAttachment(p);
        } catch (err) {
            console.warn(`[attachments] resolve failed: ${err.message}`);
            textSegments.push(`[attachment skipped: ${err.message}]`);
            continue;
        }
        if (!resolved) {
            textSegments.push('[attachment skipped: unrecognized format]');
            continue;
        }
        _appendResolved({ resolved, attachments, textSegments, turnId, count });
    }

    return {
        text: textSegments.join('\n'),
        attachments,
    };
}

module.exports = {
    classifyParts,
    classifyPartsAsync,
    AttachmentBudgetError,
    MODE,
};
