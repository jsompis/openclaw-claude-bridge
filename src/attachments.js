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
const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');

const MODE = process.env.OPENCLAW_BRIDGE_ATTACHMENT_MODE || 'passthrough';
const PER_TURN_CAP = parseInt(process.env.OPENCLAW_BRIDGE_ATTACHMENT_PER_TURN_CAP) || 20;
const SESSION_BUDGET_MB = parseInt(process.env.OPENCLAW_BRIDGE_ATTACHMENT_SESSION_BUDGET_MB) || 500;
const DOWNLOAD_TIMEOUT_MS = parseInt(process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS) || 30000;
const DEFAULT_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
const ATTACHMENT_MAX_BYTES = _parsePositiveInt(
    process.env.OPENCLAW_BRIDGE_ATTACHMENT_MAX_BYTES,
    _parsePositiveInt(process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_MAX_BYTES, DEFAULT_ATTACHMENT_MAX_BYTES)
);
const DOWNLOAD_MAX_BYTES = _parsePositiveInt(process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_MAX_BYTES, ATTACHMENT_MAX_BYTES);
const DOWNLOAD_MAX_REDIRECTS = 10;

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

function _parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function _attachmentMaxBytesMessage(actual, max = ATTACHMENT_MAX_BYTES) {
    return `attachment exceeded max bytes (${actual} > ${max})`;
}

function _assertAttachmentBytesWithinLimit(byteLength) {
    if (byteLength > ATTACHMENT_MAX_BYTES) {
        throw new Error(_attachmentMaxBytesMessage(byteLength));
    }
}

function _base64DecodedLength(payload) {
    const normalized = String(payload || '').replace(/\s/g, '');
    if (!normalized) return 0;
    const padding = normalized.endsWith('==') ? 2 : (normalized.endsWith('=') ? 1 : 0);
    return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function _decodeBase64Attachment(payload) {
    _assertAttachmentBytesWithinLimit(_base64DecodedLength(payload));
    const bytes = Buffer.from(payload, 'base64');
    _assertAttachmentBytesWithinLimit(bytes.byteLength);
    return bytes;
}

function _readLocalAttachmentBytes(abs) {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return null;
    _assertAttachmentBytesWithinLimit(stat.size);
    const bytes = fs.readFileSync(abs);
    _assertAttachmentBytesWithinLimit(bytes.byteLength);
    return bytes;
}

function _enforceResolvedAttachmentLimit(resolved) {
    if (!resolved) return null;
    _assertAttachmentBytesWithinLimit(resolved.bytes?.byteLength || 0);
    return resolved;
}

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
    if (isBase64) {
        return { mime, buf: _decodeBase64Attachment(payload) };
    }
    const decoded = decodeURIComponent(payload);
    _assertAttachmentBytesWithinLimit(Buffer.byteLength(decoded, 'utf8'));
    const buf = Buffer.from(decoded, 'utf8');
    _assertAttachmentBytesWithinLimit(buf.byteLength);
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

function _stripIpv6Brackets(hostname) {
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
        return hostname.slice(1, -1);
    }
    return hostname;
}

function _normalizeHostname(hostname) {
    return _stripIpv6Brackets(String(hostname || '').trim().toLowerCase()).replace(/\.+$/, '');
}

function _ipv4ToInt(ip) {
    const parts = ip.split('.').map(part => Number(part));
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
        return null;
    }
    return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function _expandIpv6(ip) {
    let value = _stripIpv6Brackets(ip).toLowerCase();
    const zoneIndex = value.indexOf('%');
    if (zoneIndex !== -1) value = value.slice(0, zoneIndex);
    if (value.includes('.')) {
        const lastColon = value.lastIndexOf(':');
        const ipv4 = value.slice(lastColon + 1);
        const ipv4Int = _ipv4ToInt(ipv4);
        if (ipv4Int === null) return null;
        const high = ((ipv4Int >>> 16) & 0xffff).toString(16);
        const low = (ipv4Int & 0xffff).toString(16);
        value = value.slice(0, lastColon) + ':' + high + ':' + low;
    }

    const pieces = value.split('::');
    if (pieces.length > 2) return null;
    const left = pieces[0] ? pieces[0].split(':') : [];
    const right = pieces.length === 2 && pieces[1] ? pieces[1].split(':') : [];
    const missing = pieces.length === 2 ? 8 - left.length - right.length : 0;
    if (missing < 0) return null;
    const groups = pieces.length === 2
        ? [...left, ...Array(missing).fill('0'), ...right]
        : left;
    if (groups.length !== 8) return null;

    let out = 0n;
    for (const group of groups) {
        if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
        out = (out << 16n) + BigInt(parseInt(group, 16));
    }
    return out;
}

function _ipv4FromMappedIpv6(ip) {
    const big = _expandIpv6(ip);
    if (big === null) return null;
    if ((big >> 32n) !== 0xffffn) return null;
    const n = Number(big & 0xffffffffn);
    return [
        (n >>> 24) & 0xff,
        (n >>> 16) & 0xff,
        (n >>> 8) & 0xff,
        n & 0xff,
    ].join('.');
}

function _cidrContains(ip, range) {
    const version = net.isIP(_stripIpv6Brackets(ip));
    if (version !== range.version) return false;
    if (version === 4) {
        const value = _ipv4ToInt(ip);
        const base = _ipv4ToInt(range.address);
        if (value === null || base === null) return false;
        if (range.prefix === 0) return true;
        const mask = (0xffffffff << (32 - range.prefix)) >>> 0;
        return (value & mask) === (base & mask);
    }

    const value = _expandIpv6(ip);
    const base = _expandIpv6(range.address);
    if (value === null || base === null) return false;
    if (range.prefix === 0) return true;
    const shift = BigInt(128 - range.prefix);
    return (value >> shift) === (base >> shift);
}

function _isBlockedHostname(hostname) {
    const host = _normalizeHostname(hostname);
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    // Reject common private/discovery suffixes before DNS resolution. These names
    // often resolve via local network services and should never be attachment
    // download targets.
    if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localdomain') || host.endsWith('.lan') || host.endsWith('.home')) {
        return true;
    }
    return new Set([
        'metadata',
        'metadata.google.internal',
        'metadata.internal',
        'metadata.local',
        'instance-data',
        'instance-data.ec2.internal',
    ]).has(host);
}

function _isBlockedIPv4(ip) {
    const value = _ipv4ToInt(ip);
    if (value === null) return true;
    const ranges = [
        ['0.0.0.0', 8],
        ['10.0.0.0', 8],
        ['100.64.0.0', 10],
        ['127.0.0.0', 8],
        ['169.254.0.0', 16],
        ['172.16.0.0', 12],
        ['192.0.0.0', 24],
        ['192.168.0.0', 16],
        ['198.18.0.0', 15],
        ['224.0.0.0', 4],
        ['240.0.0.0', 4],
    ];
    return ranges.some(([base, prefix]) => _cidrContains(ip, { type: 'cidr', version: 4, address: base, prefix }));
}

function _isBlockedIPv6(ip) {
    const mapped = _ipv4FromMappedIpv6(ip);
    if (mapped) return _isBlockedIPv4(mapped);
    const value = _expandIpv6(ip);
    if (value === null) return true;
    const ranges = [
        ['::', 128],
        ['::1', 128],
        ['fc00::', 7],
        ['fe80::', 10],
        ['ff00::', 8],
    ];
    return ranges.some(([base, prefix]) => _cidrContains(ip, { type: 'cidr', version: 6, address: base, prefix }));
}

function _isBlockedIp(ip) {
    const address = _normalizeHostname(ip);
    const version = net.isIP(address);
    if (version === 4) return _isBlockedIPv4(address);
    if (version === 6) return _isBlockedIPv6(address);
    return true;
}

async function _validateRemoteUrlForDownload(inputUrl) {
    const parsed = inputUrl instanceof URL ? inputUrl : new URL(inputUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('remote attachment URL blocked by SSRF policy: unsupported protocol ' + parsed.protocol);
    }
    if (parsed.username || parsed.password) {
        throw new Error('remote attachment URL blocked by SSRF policy: credentials are not allowed');
    }

    const hostname = _normalizeHostname(parsed.hostname);
    if (!hostname) {
        throw new Error('remote attachment URL blocked by SSRF policy: missing hostname');
    }
    if (_isBlockedHostname(hostname)) {
        throw new Error('remote attachment URL blocked by SSRF policy: blocked hostname ' + hostname);
    }

    if (net.isIP(hostname)) {
        if (_isBlockedIp(hostname)) {
            throw new Error('remote attachment URL blocked by SSRF policy: blocked address ' + hostname);
        }
        return;
    }

    let records;
    try {
        records = await dns.lookup(hostname, { all: true, verbatim: false });
    } catch (err) {
        throw new Error('download failed: DNS lookup failed for ' + hostname + ': ' + err.message);
    }
    if (!records.length) {
        throw new Error('download failed: DNS lookup returned no addresses for ' + hostname);
    }
    for (const record of records) {
        const address = _normalizeHostname(record.address);
        if (_isBlockedIp(address)) {
            throw new Error('remote attachment URL blocked by SSRF policy: ' + hostname + ' resolved to blocked address ' + address);
        }
    }
}

function _isRedirectStatus(status) {
    return [301, 302, 303, 307, 308].includes(status);
}

async function _cancelResponseBody(response) {
    try {
        if (response?.body && typeof response.body.cancel === 'function') {
            await response.body.cancel();
        }
    } catch {}
}

async function _download(url) {
    if (typeof fetch !== 'function') {
        throw new Error('remote attachment downloads require global fetch');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
        let currentUrl = new URL(url);
        let response = null;
        for (let redirects = 0; redirects <= DOWNLOAD_MAX_REDIRECTS; redirects++) {
            await _validateRemoteUrlForDownload(currentUrl);
            response = await fetch(currentUrl, { signal: controller.signal, redirect: 'manual' });
            if (!_isRedirectStatus(response.status)) break;

            const location = response.headers.get('location');
            await _cancelResponseBody(response);
            if (!location) {
                throw new Error(`download failed: HTTP ${response.status} redirect missing Location`);
            }
            if (redirects === DOWNLOAD_MAX_REDIRECTS) {
                throw new Error(`download failed: too many redirects (>${DOWNLOAD_MAX_REDIRECTS})`);
            }
            currentUrl = new URL(location, currentUrl);
        }

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
        if (/^remote attachment URL blocked by SSRF policy/.test(err?.message || '')) {
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
        const bytes = _readLocalAttachmentBytes(abs);
        if (bytes === null) return null;
        return {
            bytes,
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
            return _enforceResolvedAttachmentLimit(_finalizeImageAttachment({ bytes: buf, mime, name: _nameFromUrl(url) }));
        }
        return _enforceResolvedAttachmentLimit(_finalizeImageAttachment(_resolveLocalOrDataUrl(url)));
    }

    if (part.type === 'file') {
        const f = part.file || {};
        let name = f.filename || f.name || null;
        let bytes = null;
        let mime = null;
        if (f.file_data) {
            bytes = _decodeBase64Attachment(f.file_data);
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
            bytes = _readLocalAttachmentBytes(abs);
            if (bytes === null) return null;
            if (!name) name = path.basename(abs);
        } else {
            return null;
        }
        const ext = _safeExt(name);
        mime = mime || _mimeFromExt(ext);
        return _enforceResolvedAttachmentLimit({ bytes, mime, name });
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
        return _enforceResolvedAttachmentLimit(_finalizeImageAttachment(_resolveLocalOrDataUrl(url)));
    }

    if (part.type === 'file') {
        const f = part.file || {};
        let name = f.filename || f.name || null;
        let bytes = null;
        let mime = null;
        if (f.file_data) {
            bytes = _decodeBase64Attachment(f.file_data);
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
            bytes = _readLocalAttachmentBytes(abs);
            if (bytes === null) return null;
            if (!name) name = path.basename(abs);
        } else {
            return null;
        }
        const ext = _safeExt(name);
        mime = mime || _mimeFromExt(ext);
        return _enforceResolvedAttachmentLimit({ bytes, mime, name });
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
    ATTACHMENT_MAX_BYTES,
    DOWNLOAD_MAX_BYTES,
    MODE,
};
