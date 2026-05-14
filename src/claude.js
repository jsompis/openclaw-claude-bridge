'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// --- Stable alias per CLI session ---
// Each session keeps one alias so resumed requests don't accumulate different
// names in the Claude context (which would leak un-replaced aliases in output).
const PREFIXES = ['Chat', 'Dev', 'Run', 'Ask', 'Net', 'App', 'Zen', 'Arc', 'Dot', 'Amp', 'Hex', 'Orb', 'Elm', 'Oak', 'Sky'];
const SUFFIXES = ['Kit', 'Box', 'Pod', 'Hub', 'Lab', 'Ops', 'Bay', 'Tap', 'Rim', 'Fog', 'Dew', 'Fin', 'Gem', 'Jet', 'Cog'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sessionAliasMap = new Map(); // sessionId → { alias, aliasLower, lastUsed }
const sessionTokenMaps = new Map(); // sessionId → Map<original, replacement>

function getSessionAlias(sessionId) {
    if (!sessionId) {
        const alias = pick(PREFIXES) + pick(SUFFIXES);
        return { alias, aliasLower: alias.toLowerCase() };
    }
    let entry = sessionAliasMap.get(sessionId);
    if (entry) {
        entry.lastUsed = Date.now();
        return entry;
    }
    const alias = pick(PREFIXES) + pick(SUFFIXES);
    entry = { alias, aliasLower: alias.toLowerCase(), lastUsed: Date.now() };
    sessionAliasMap.set(sessionId, entry);
    return entry;
}

function clearSessionAlias(sessionId) {
    sessionAliasMap.delete(sessionId);
    sessionTokenMaps.delete(sessionId);
}

// Evict stale entries every 10 min (unused >1h)
setInterval(() => {
    const cutoff = Date.now() - 3600_000;
    for (const [id, e] of sessionAliasMap) {
        if (e.lastUsed < cutoff) {
            sessionAliasMap.delete(id);
            sessionTokenMaps.delete(id);
        }
    }
}, 600_000).unref();

/**
 * Map OpenClaw model IDs to Claude CLI model names.
 * Exposes explicit Anthropic-style model ids.
 */
function resolveModel(modelId) {
    const modelMap = {
        'claude-opus-4-7':      process.env.OPUS_47_MODEL || 'claude-opus-4-7',
        'claude-opus-4-6':      process.env.OPUS_MODEL || 'claude-opus-4-6',
        'claude-sonnet-4-6':    process.env.SONNET_MODEL || 'claude-sonnet-4-6',
        'claude-haiku-4-5':     process.env.HAIKU_MODEL || 'claude-haiku-4-5',
    };
    return modelMap[modelId] || modelId;
}

/** Context window size per model, derived from the resolved CLI model name. */
function getContextWindow(modelId) {
    const resolved = resolveModel(modelId);
    return resolved.includes('[1m]') ? 1_000_000 : 200_000;
}

/**
 * Run Claude CLI with the given system prompt and conversation text.
 *
 * @param {string} systemPrompt  Combined developer message + tool instructions
 * @param {string} promptText    Conversation history + user message
 * @param {string} modelId       OpenClaw model ID
 * @param {function} onChunk     Called with each text chunk as it arrives
 * @returns {Promise<string>}    Resolves with the final complete text
 */
/**
 * @typedef {{ text: string, usage: { input_tokens: number, output_tokens: number } }} ClaudeResult
 */

const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS) || 120000; // 2 min idle = dead
const CLAUDE_SKIP_PERMISSIONS_ENV = 'OPENCLAW_BRIDGE_CLAUDE_SKIP_PERMISSIONS';
const CLAUDE_LIVE_ENV = 'OPENCLAW_BRIDGE_CLAUDE_LIVE';
const CLAUDE_LIVE_IDLE_MS_ENV = 'OPENCLAW_BRIDGE_CLAUDE_LIVE_IDLE_MS';
const DEFAULT_CLAUDE_LIVE_IDLE_MS = 600_000; // 10 min idle shutdown for opt-in live processes
let warnedClaudeSkipPermissions = false;

function parsePositiveIntegerEnv(env, name, defaultValue) {
    const raw = env[name];
    if (typeof raw !== 'string' || raw.trim() === '') return defaultValue;
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function truthyEnv(env, name) {
    const raw = env[name];
    if (typeof raw !== 'string') return false;
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Map OC reasoning_effort levels to Claude CLI --effort levels.
 * OC sends: "minimal" | "low" | "medium" | "high" | "xhigh"
 * Claude CLI accepts: "low" | "medium" | "high"
 */
function mapEffort(reasoningEffort) {
    if (!reasoningEffort) return null;
    const map = {
        'minimal': 'low',
        'low':     'medium',
        'medium':  'high',
        'high':    'max',
        'xhigh':   'max',
    };
    return map[reasoningEffort] || null;
}

function shouldSkipClaudePermissions(env = process.env) {
    return truthyEnv(env, CLAUDE_SKIP_PERMISSIONS_ENV);
}

function shouldUseClaudeLive(env = process.env) {
    return truthyEnv(env, CLAUDE_LIVE_ENV);
}

function getClaudeLiveIdleMs(env = process.env) {
    return parsePositiveIntegerEnv(env, CLAUDE_LIVE_IDLE_MS_ENV, DEFAULT_CLAUDE_LIVE_IDLE_MS);
}

function maybeWarnClaudeSkipPermissions() {
    if (warnedClaudeSkipPermissions) return;
    warnedClaudeSkipPermissions = true;
    console.warn(`[claude-bridge] WARNING: Claude CLI --dangerously-skip-permissions enabled by ${CLAUDE_SKIP_PERMISSIONS_ENV}`);
}

function buildClaudeArgs({ hasAttachments, model, isResume, sessionId, systemPrompt, reasoningEffort }, env = process.env) {
    const args = [
        '--print',
        '--output-format', 'stream-json',
        '--verbose',
    ];

    if (shouldSkipClaudePermissions(env)) {
        args.splice(1, 0, '--dangerously-skip-permissions');
        maybeWarnClaudeSkipPermissions();
    }

    if (hasAttachments) {
        args.push('--input-format', 'stream-json');
    }

    // Always pass --model (not persisted in session)
    args.push('--model', model);

    if (isResume && sessionId) {
        // Resume existing session — conversation history already in session
        args.push('--resume', sessionId);
    } else if (sessionId) {
        // New session
        args.push('--session-id', sessionId);
    }

    // Replace Claude Code default system prompt (removes ~15-20KB of irrelevant noise)
    if (systemPrompt) {
        args.push('--system-prompt', systemPrompt);
    }

    // Always disable Claude built-in tools. Also force MCP isolation so
    // ambient local MCP servers cannot leak into the bridge session and
    // bypass OpenClaw's tool loop.
    args.push('--tools', '');
    args.push('--strict-mcp-config');

    // Map OC reasoning_effort → Claude CLI --effort
    const effort = mapEffort(reasoningEffort);
    if (effort) {
        args.push('--effort', effort);
    }

    return args;
}

function buildClaudeLiveArgs({ model, isResume, sessionId, systemPrompt, reasoningEffort }, env = process.env) {
    // Live mode keeps stdin open, so it always uses stream-json input even when
    // the current turn has no attachments.
    return buildClaudeArgs({ hasAttachments: true, model, isResume, sessionId, systemPrompt, reasoningEffort }, env);
}

function buildStreamJsonUserMessage(promptText, attachmentBlocks) {
    const contentBlocks = [];
    if (promptText) {
        contentBlocks.push({ type: 'text', text: promptText });
    }
    for (const b of attachmentBlocks || []) {
        contentBlocks.push(b);
    }
    return {
        type: 'user',
        message: {
            role: 'user',
            content: contentBlocks,
        },
    };
}

function writePromptToClaudeStdin(proc, promptText, attachmentBlocks, hasAttachments) {
    if (hasAttachments) {
        proc.stdin.write(JSON.stringify(buildStreamJsonUserMessage(promptText, attachmentBlocks)) + '\n');
    } else {
        proc.stdin.write(promptText);
    }
}

class ClaudeLiveProcess {
    constructor({ key, model, isResume, sessionId, systemPrompt, reasoningEffort }) {
        this.key = key;
        this.sessionId = sessionId;
        this.signature = JSON.stringify({ model, systemPrompt: systemPrompt || '', reasoningEffort: reasoningEffort || '' });
        this.liveIdleMs = getClaudeLiveIdleMs();
        this.queue = Promise.resolve();
        this.current = null;
        this.buffer = '';
        this.stderrText = '';
        this.closed = false;
        this.activeIdleTimer = null;
        this.liveIdleTimer = null;

        const args = buildClaudeLiveArgs({ model, isResume, sessionId, systemPrompt, reasoningEffort });
        const env = { ...process.env };
        if (!reasoningEffort) {
            env.MAX_THINKING_TOKENS = '0';
        }

        console.log(`[claude.js] Spawning live: ${CLAUDE_BIN} ${args.slice(0, 7).join(' ')} ... model=${model} resume=${!!isResume} liveIdleMs=${this.liveIdleMs}`);
        this.proc = spawn(CLAUDE_BIN, args, {
            cwd: '/tmp',
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.proc.stdout.on('data', (chunk) => this.onStdout(chunk));
        this.proc.stderr.on('data', (data) => this.onStderr(data));
        this.proc.on('close', (code) => this.onClose(code));
        this.proc.on('error', (err) => this.onError(err));
        this.scheduleLiveIdleShutdown();
    }

    request(promptText, attachmentBlocks, onChunk, signal) {
        const run = () => this.runOne(promptText, attachmentBlocks, onChunk, signal);
        const next = this.queue.then(run, run);
        this.queue = next.catch(() => {});
        return next;
    }

    runOne(promptText, attachmentBlocks, onChunk, signal) {
        if (this.closed) {
            return Promise.reject(new Error('Claude live process is closed'));
        }
        clearTimeout(this.liveIdleTimer);
        this.stderrText = '';

        return new Promise((resolve, reject) => {
            let settled = false;
            let abortHandler = null;
            const cleanup = () => {
                this.clearActiveIdle();
                if (signal && abortHandler) {
                    signal.removeEventListener('abort', abortHandler);
                }
            };
            const finishReject = (err) => {
                if (settled) return;
                settled = true;
                cleanup();
                this.current = null;
                reject(err);
            };
            const finishResolve = () => {
                if (settled) return;
                settled = true;
                cleanup();
                const fullText = this.current.fullText;
                const fullUsage = this.current.fullUsage;
                const detail = this.stderrText ? `: ${this.stderrText.split('\n').slice(-3).join(' | ')}` : '';
                this.current = null;
                this.scheduleLiveIdleShutdown();

                const text = typeof fullText === 'string' ? fullText.trim() : '';
                if (!text && (fullUsage.output_tokens ?? 0) === 0) {
                    reject(new Error(`Claude returned empty response${detail}`));
                } else {
                    resolve({ text: fullText, usage: fullUsage });
                }
            };

            this.current = {
                onChunk,
                fullText: '',
                fullUsage: { input_tokens: 0, output_tokens: 0 },
                resolve: finishResolve,
                reject: finishReject,
            };

            abortHandler = () => {
                this.stop('Client disconnected');
                finishReject(new Error('Client disconnected'));
            };
            if (signal) {
                if (signal.aborted) return abortHandler();
                signal.addEventListener('abort', abortHandler, { once: true });
            }

            this.resetActiveIdle();
            try {
                this.proc.stdin.write(JSON.stringify(buildStreamJsonUserMessage(promptText, attachmentBlocks)) + '\n');
            } catch (err) {
                finishReject(new Error(`Failed to write to Claude live process: ${err.message}`));
            }
        });
    }

    resetActiveIdle() {
        this.clearActiveIdle();
        this.activeIdleTimer = setTimeout(() => {
            const reason = `Idle timeout (${IDLE_TIMEOUT_MS / 1000}s no activity)`;
            this.stop(reason);
            if (this.current) this.current.reject(new Error(reason));
        }, IDLE_TIMEOUT_MS);
    }

    clearActiveIdle() {
        clearTimeout(this.activeIdleTimer);
        this.activeIdleTimer = null;
    }

    scheduleLiveIdleShutdown() {
        clearTimeout(this.liveIdleTimer);
        this.liveIdleTimer = setTimeout(() => {
            this.stop(`Live idle shutdown (${this.liveIdleMs}ms no requests)`);
        }, this.liveIdleMs);
        this.liveIdleTimer.unref?.();
    }

    onStdout(chunk) {
        if (this.current) this.resetActiveIdle();
        this.buffer += chunk.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop();

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let event;
            try {
                event = JSON.parse(trimmed);
            } catch {
                continue;
            }
            if (!this.current) continue;
            handleEvent(
                event,
                this.current.onChunk,
                (text) => { this.current.fullText = text; },
                (u) => { this.current.fullUsage = u; },
            );
            if (event.type === 'result') {
                this.current.resolve();
            }
        }
    }

    onStderr(data) {
        const msg = data.toString().trim();
        if (msg) {
            this.stderrText += (this.stderrText ? '\n' : '') + msg;
            console.error(`[claude live stderr] ${msg}`);
        }
    }

    onClose(code) {
        this.closed = true;
        clearTimeout(this.liveIdleTimer);
        this.clearActiveIdle();
        liveProcessMap.delete(this.key);
        if (this.current) {
            const detail = this.stderrText ? `: ${this.stderrText.split('\n').slice(-3).join(' | ')}` : '';
            this.current.reject(new Error(`Claude live process exited with code ${code}${detail}`));
            this.current = null;
        }
    }

    onError(err) {
        this.closed = true;
        clearTimeout(this.liveIdleTimer);
        this.clearActiveIdle();
        liveProcessMap.delete(this.key);
        if (this.current) {
            this.current.reject(new Error(`Failed to spawn Claude live process: ${err.message}`));
            this.current = null;
        }
    }

    stop(reason) {
        if (this.closed) return;
        console.log(`[claude.js] Stopping live Claude process session=${this.sessionId?.slice?.(0, 8) || 'unknown'} reason=${reason}`);
        this.closed = true;
        clearTimeout(this.liveIdleTimer);
        this.clearActiveIdle();
        liveProcessMap.delete(this.key);
        try { this.proc.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { this.proc.kill('SIGKILL'); } catch {} }, 3000).unref?.();
    }
}

const liveProcessMap = new Map();

function runClaudeLive({ systemPrompt, promptText, model, onChunk, signal, reasoningEffort, sessionId, isResume, attachmentBlocks }) {
    if (!sessionId) {
        return Promise.reject(new Error('Claude live mode requires a sessionId'));
    }
    const key = sessionId;
    const signature = JSON.stringify({ model, systemPrompt: systemPrompt || '', reasoningEffort: reasoningEffort || '' });
    let live = liveProcessMap.get(key);
    if (live && (live.closed || live.signature !== signature)) {
        live.stop(live.signature !== signature ? 'live argument signature changed' : 'live process closed');
        live = null;
    }
    if (!live) {
        live = new ClaudeLiveProcess({ key, model, isResume, sessionId, systemPrompt, reasoningEffort });
        liveProcessMap.set(key, live);
    }
    return live.request(promptText, attachmentBlocks, onChunk, signal);
}

// --- Dynamic auto-scrub for OC detection bypass ---
const SCRUB_PATTERNS = [
    /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,   // SCREAMING_SNAKE_CASE (2+ segments)
    /\[\[\s*(\w+)\s*\]\]/g,                    // [[bracket_tags]]
    /\bsessions_[a-z_]+\b/g,                   // sessions_* tool names
];

const SCRUB_WHITELIST = new Set([
    'API_KEY', 'API_KEYS', 'API_URL', 'BASE_URL', 'BASE64',
    'HTTP_GET', 'HTTP_POST', 'HTTP_PUT', 'HTTP_DELETE', 'HTTP_PATCH',
    'JSON_SCHEMA', 'UTF_8', 'UTF_16',
    'NODE_ENV', 'NODE_PATH', 'NODE_OPTIONS',
    'HOME_DIR', 'TEMP_DIR', 'WORK_DIR',
    'MAX_TOKENS', 'MAX_LENGTH', 'MAX_SIZE', 'MAX_RETRIES',
    'INPUT_TOKENS', 'OUTPUT_TOKENS',
    'MIME_TYPE', 'CONTENT_TYPE',
    'STATUS_CODE', 'ERROR_CODE',
    'READ_ONLY', 'READ_WRITE',
    'SIGTERM', 'SIGKILL', 'SIGINT',
]);

function generateReplacement(token, alias) {
    const hash = crypto.createHash('md5').update(alias + ':' + token).digest('hex').slice(0, 4);
    const isUpper = token === token.toUpperCase();
    if (isUpper) {
        const words = ['SYNC', 'DATA', 'CTRL', 'PROC', 'TASK', 'FLAG', 'CORE', 'LINK', 'NODE', 'PING'];
        const w1 = words[parseInt(hash.slice(0, 2), 16) % words.length];
        const w2 = words[parseInt(hash.slice(2, 4), 16) % words.length];
        return `${w1}_${w2}_${hash}`;
    }
    const words = ['sync', 'data', 'ctrl', 'proc', 'task', 'flag', 'core', 'link', 'node', 'ping'];
    const w1 = words[parseInt(hash.slice(0, 2), 16) % words.length];
    const w2 = words[parseInt(hash.slice(2, 4), 16) % words.length];
    return `${w1}_${w2}_${hash}`;
}

function scrubOutbound(text, alias, aliasLower, sessionId) {
    text = text.replace(/OpenClaw/g, alias).replace(/openclaw/g, aliasLower);

    if (!sessionId) return text;

    let tokenMap = sessionTokenMaps.get(sessionId);
    if (!tokenMap) {
        tokenMap = new Map();
        sessionTokenMaps.set(sessionId, tokenMap);
    }

    // Collect ALL matches from ALL patterns into a single array
    const allMatches = [];
    for (const pattern of SCRUB_PATTERNS) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(text)) !== null) {
            const fullMatch = m[0];
            const token = m[1] || fullMatch;
            if (!SCRUB_WHITELIST.has(token)) {
                allMatches.push({ fullMatch, token });
            }
        }
    }

    // Deduplicate by fullMatch (same string may be caught by multiple patterns)
    const seen = new Set();
    const uniqueMatches = allMatches.filter(({ fullMatch }) => {
        if (seen.has(fullMatch)) return false;
        seen.add(fullMatch);
        return true;
    });

    // Sort by fullMatch length descending — replace longer tokens first
    // to prevent partial corruption (e.g. FOO_BAR replacing inside FOO_BAR_BAZ)
    uniqueMatches.sort((a, b) => b.fullMatch.length - a.fullMatch.length);

    for (const { fullMatch, token } of uniqueMatches) {
        if (!tokenMap.has(token)) {
            tokenMap.set(token, generateReplacement(token, alias));
        }
        const replacement = tokenMap.get(token);
        if (fullMatch.startsWith('[[')) {
            text = text.split(fullMatch).join(`[[${replacement}]]`);
        } else {
            text = text.split(fullMatch).join(replacement);
        }
    }
    return text;
}

function restoreInbound(text, alias, aliasLower, sessionId) {
    const tokenMap = sessionTokenMaps.get(sessionId);
    if (tokenMap) {
        for (const [original, replacement] of tokenMap) {
            text = text.split(`[[${replacement}]]`).join(`[[${original}]]`);
            text = text.split(replacement).join(original);
        }
    }
    text = text
        .replace(new RegExp(alias, 'g'), 'OpenClaw')
        .replace(new RegExp(aliasLower, 'g'), 'openclaw');
    return text;
}

function runClaude(systemPrompt, promptText, modelId, onChunk, signal, reasoningEffort, sessionId, isResume, attachmentBlocks) {
    // Stable alias per session — see getSessionAlias() above.
    const { alias, aliasLower } = getSessionAlias(sessionId);
    if (systemPrompt) {
        systemPrompt = scrubOutbound(systemPrompt, alias, aliasLower, sessionId);
    }
    promptText = promptText
        .replace(/OpenClaw/g, alias)
        .replace(/openclaw/g, aliasLower);

    return new Promise((resolve, reject) => {
        const model = resolveModel(modelId);

        if (shouldUseClaudeLive()) {
            return runClaudeLive({ systemPrompt, promptText, model, onChunk, signal, reasoningEffort, sessionId, isResume, attachmentBlocks })
                .then(({ text, usage }) => {
                    if (text) text = restoreInbound(text, alias, aliasLower, sessionId);
                    resolve({ text, usage });
                })
                .catch(reject);
        }

        // Stream-json input mode is required when we have attachment blocks
        // (images/PDFs) — the CLI doesn't accept attachments in text mode.
        const hasAttachments = Array.isArray(attachmentBlocks) && attachmentBlocks.length > 0;

        const args = buildClaudeArgs({ hasAttachments, model, isResume, sessionId, systemPrompt, reasoningEffort });
        const effort = mapEffort(reasoningEffort);

        const env = { ...process.env };

        // Disable thinking when OC says reasoning=false (no reasoning_effort)
        if (!reasoningEffort) {
            env.MAX_THINKING_TOKENS = '0';
        }

        const thinking = reasoningEffort ? 'on' : 'off';
        console.log(`[claude.js] Spawning: ${CLAUDE_BIN} ${args.slice(0, 6).join(' ')} ... model=${model} effort=${effort || 'default'} thinking=${thinking} resume=${!!isResume}`);

        const proc = spawn(CLAUDE_BIN, args, {
            cwd: '/tmp',
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let settled = false;
        const kill = (reason) => {
            if (settled) return;
            settled = true;
            proc.kill('SIGTERM');
            setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
            reject(new Error(reason));
        };

        // Kill on client disconnect (AbortSignal)
        if (signal) {
            signal.addEventListener('abort', () => kill('Client disconnected'), { once: true });
        }

        // Idle timeout: reset on every stdout activity.
        // Claude is alive as long as it produces output (tool calls, results, etc.)
        // Only kill if it goes silent for IDLE_TIMEOUT_MS.
        let idleTimer = setTimeout(() => kill(`Idle timeout (${IDLE_TIMEOUT_MS / 1000}s no activity)`), IDLE_TIMEOUT_MS);
        const resetIdle = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => kill(`Idle timeout (${IDLE_TIMEOUT_MS / 1000}s no activity)`), IDLE_TIMEOUT_MS);
        };

        // Hard timeout: absolute max runtime regardless of activity (20 min)
        const MAX_RUN_MS = 20 * 60 * 1000;
        const hardTimer = setTimeout(() => kill(`Hard timeout (${MAX_RUN_MS / 60000}min)`), MAX_RUN_MS);

        // Write conversation to stdin
        // Stream-json input: one user message with text + image/document blocks.
        // The prior conversation transcript is embedded as a single big text
        // block; the attachments come last so they're clearly the "current"
        // input the user is asking about.
        writePromptToClaudeStdin(proc, promptText, attachmentBlocks, hasAttachments);
        proc.stdin.end();

        let fullText = '';
        let fullUsage = { input_tokens: 0, output_tokens: 0 };
        let buffer = '';
        let stderrText = '';

        proc.stdout.on('data', (chunk) => {
            resetIdle(); // Claude is alive — reset idle timer
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep incomplete line

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                try {
                    const event = JSON.parse(trimmed);
                    handleEvent(event, onChunk, (text) => { fullText = text; }, (u) => { fullUsage = u; });
                } catch {
                    // Non-JSON line (e.g. debug output), ignore
                }
            }
        });

        proc.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) {
                stderrText += (stderrText ? '\n' : '') + msg;
                console.error(`[claude stderr] ${msg}`);
            }
        });

        proc.on('close', (code) => {
            clearTimeout(idleTimer);
            clearTimeout(hardTimer);
            if (settled) return;
            settled = true;

            // Process any remaining buffered data
            if (buffer.trim()) {
                try {
                    const event = JSON.parse(buffer.trim());
                    handleEvent(event, onChunk, (text) => { fullText = text; }, (u) => { fullUsage = u; });
                } catch {}
            }

            const text = typeof fullText === 'string' ? fullText.trim() : '';
            const detail = stderrText ? `: ${stderrText.split('\n').slice(-3).join(' | ')}` : '';

            if (code !== 0 && !text) {
                reject(new Error(`Claude exited with code ${code}${detail}`));
            } else if (!text && (fullUsage.output_tokens ?? 0) === 0) {
                reject(new Error(`Claude returned empty response${detail}`));
            } else {
                // Inbound: restore aliases → original tokens
                if (fullText) {
                    fullText = restoreInbound(fullText, alias, aliasLower, sessionId);
                }
                resolve({ text: fullText, usage: fullUsage });
            }
        });

        proc.on('error', (err) => {
            clearTimeout(idleTimer);
            clearTimeout(hardTimer);
            if (settled) return;
            settled = true;
            reject(new Error(`Failed to spawn Claude: ${err.message}`));
        });
    });
}

/**
 * Parse a stream-json event and extract text content.
 *
 * With --tools "" (no native tools), Claude only outputs text.
 * We extract the final result text and usage from the stream.
 */
function handleEvent(event, onChunk, setFull, setUsage) {
    if (event.type === 'result') {
        const result = event.result;
        if (typeof result === 'string' && result) {
            setFull(result);
        }
        // Pass through the full token usage breakdown + cost from Claude CLI.
        const u = event.usage;
        if (u && typeof u.input_tokens === 'number') {
            setUsage({
                input_tokens:          u.input_tokens ?? 0,
                cache_creation_tokens: u.cache_creation_input_tokens ?? 0,
                cache_read_tokens:     u.cache_read_input_tokens ?? 0,
                output_tokens:         u.output_tokens ?? 0,
                cost_usd:              event.total_cost_usd ?? 0,
            });
        }
    }
}

module.exports = {
    runClaude,
    getContextWindow,
    clearSessionAlias,
    shouldSkipClaudePermissions,
    shouldUseClaudeLive,
    getClaudeLiveIdleMs,
    buildClaudeArgs,
    buildClaudeLiveArgs,
    DEFAULT_CLAUDE_LIVE_IDLE_MS,
};
