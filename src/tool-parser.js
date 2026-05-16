'use strict';

const { v4: uuidv4 } = require('uuid');

function normalizeJsonish(text) {
    let out = '';
    let inString = false;
    let escape = false;
    for (const ch of text) {
        if (escape) {
            out += ch;
            escape = false;
            continue;
        }
        if (ch === '\\') {
            out += ch;
            escape = true;
            continue;
        }
        if (ch === '"') {
            out += ch;
            inString = !inString;
            continue;
        }
        if (inString) {
            if (ch === '\n') { out += '\\n'; continue; }
            if (ch === '\r') { out += '\\r'; continue; }
            if (ch === '\t') { out += '\\t'; continue; }
        }
        out += ch;
    }
    return out;
}

function parseLooseJson(jsonText) {
    try {
        return { parsed: JSON.parse(jsonText), recovered: false };
    } catch (firstErr) {
        const normalized = normalizeJsonish(jsonText);
        if (normalized !== jsonText) {
            try {
                return { parsed: JSON.parse(normalized), recovered: true };
            } catch {}
        }
        throw firstErr;
    }
}

function isAllowedToolName(name, allowedToolNames) {
    if (!allowedToolNames) return true;
    return allowedToolNames.has(name);
}

function stripCodeContexts(text) {
    const source = String(text || '');
    if (!source) return '';

    const chars = source.split('');
    const masked = new Array(source.length).fill(false);

    function maskRange(start, end) {
        const safeStart = Math.max(0, start);
        const safeEnd = Math.min(source.length, end);
        for (let i = safeStart; i < safeEnd; i += 1) {
            chars[i] = /\s/.test(source[i]) ? source[i] : ' ';
            masked[i] = true;
        }
    }

    let i = 0;
    while (i < source.length) {
        if (source.startsWith('```', i)) {
            const close = source.indexOf('```', i + 3);
            const end = close === -1 ? source.length : close + 3;
            maskRange(i, end);
            i = end;
            continue;
        }
        i += 1;
    }

    i = 0;
    while (i < source.length) {
        if (masked[i] || source[i] !== '`') {
            i += 1;
            continue;
        }

        let close = -1;
        for (let j = i + 1; j < source.length; j += 1) {
            if (masked[j] || source[j] === '\n' || source[j] === '\r') break;
            if (source[j] === '`') {
                close = j;
                break;
            }
        }

        if (close === -1) {
            i += 1;
            continue;
        }

        maskRange(i, close + 1);
        i = close + 1;
    }

    return chars.join('');
}

function coerceToolCall(raw, allowedToolNames) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) {
        return { error: 'no_json_object', preview: raw.slice(0, 300) };
    }
    const jsonText = raw.slice(start, end + 1);
    try {
        const { parsed, recovered } = parseLooseJson(jsonText);
        if (!parsed || typeof parsed.name !== 'string') {
            return { error: 'invalid_payload', preview: jsonText.slice(0, 300) };
        }
        if (!isAllowedToolName(parsed.name, allowedToolNames)) {
            return { error: 'tool_not_allowed', name: parsed.name, preview: jsonText.slice(0, 300) };
        }
        const args = (parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments))
            ? parsed.arguments
            : {};
        return {
            call: {
                id: `call_${uuidv4().slice(0, 8)}`,
                name: parsed.name,
                arguments: args,
            },
            recovered,
        };
    } catch {
        return { error: 'json_parse_failed', preview: jsonText.slice(0, 300) };
    }
}

function extractBalancedJsonObjects(text) {
    const objects = [];
    let inString = false;
    let escape = false;
    let depth = 0;
    let start = -1;

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;

        if (ch === '{') {
            if (depth === 0) start = i;
            depth += 1;
        } else if (ch === '}') {
            if (depth === 0) continue;
            depth -= 1;
            if (depth === 0 && start !== -1) {
                objects.push(text.slice(start, i + 1));
                start = -1;
            }
        }
    }
    return objects;
}

function parseExactToolCalls(text, allowedToolNames) {
    const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
    const source = String(text || '');
    const searchable = stripCodeContexts(source);
    const calls = [];
    const errors = [];
    let recoveredJson = false;
    let match;
    while ((match = regex.exec(searchable)) !== null) {
        const openTag = '<tool_call>';
        const closeTag = '</tool_call>';
        const bodyStart = match.index + openTag.length;
        const closeOffset = match[0].lastIndexOf(closeTag);
        const bodyEnd = match.index + closeOffset;
        const raw = source.slice(bodyStart, bodyEnd).trim();
        const result = coerceToolCall(raw, allowedToolNames);
        if (result.call) {
            calls.push(result.call);
            if (result.recovered) recoveredJson = true;
        } else {
            errors.push(result);
        }
    }
    return { calls, errors, recoveredJson };
}

function parseMalformedToolCall(text, allowedToolNames) {
    const source = String(text || '');
    const searchable = stripCodeContexts(source);
    const opens = [...searchable.matchAll(/<tool_call\b[^>]*>/g)];
    if (opens.length !== 1) {
        return { calls: [], repaired: false, reason: opens.length === 0 ? 'no_markup' : 'multiple_tool_call_blocks' };
    }

    const open = opens[0];
    const bodyStart = open.index + open[0].length;
    const tail = source.slice(bodyStart);
    const searchableTail = searchable.slice(bodyStart);
    const closeCandidates = ['</tool_call>', '</tool_char>']
        .map(tag => ({ tag, idx: searchableTail.indexOf(tag) }))
        .filter(c => c.idx !== -1)
        .sort((a, b) => a.idx - b.idx);
    const bodyEnd = closeCandidates.length > 0 ? closeCandidates[0].idx : tail.length;
    const raw = tail.slice(0, bodyEnd).trim();
    const jsonObjects = extractBalancedJsonObjects(raw);
    if (jsonObjects.length !== 1) {
        return { calls: [], repaired: false, reason: `json_object_count_${jsonObjects.length}` };
    }

    const result = coerceToolCall(jsonObjects[0], allowedToolNames);
    if (!result.call) {
        return { calls: [], repaired: false, reason: result.error, error: result };
    }
    return { calls: [result.call], repaired: true, closeTag: closeCandidates[0]?.tag || 'EOF', recoveredJson: result.recovered };
}

function parseBareToolCallJson(text, allowedToolNames) {
    const source = String(text || '');
    const searchable = stripCodeContexts(source);
    const trimmedSearchable = searchable.trim();
    if (!trimmedSearchable || trimmedSearchable[0] !== '{' || trimmedSearchable[trimmedSearchable.length - 1] !== '}') {
        return { calls: [], bare: false };
    }

    const objects = extractBalancedJsonObjects(trimmedSearchable);
    if (objects.length !== 1 || objects[0] !== trimmedSearchable) {
        return { calls: [], bare: false };
    }

    const trimStart = searchable.indexOf(trimmedSearchable);
    const raw = source.slice(trimStart, trimStart + trimmedSearchable.length).trim();
    let parsed;
    try {
        parsed = parseLooseJson(raw).parsed;
    } catch {
        return { calls: [], bare: false };
    }

    if (!parsed || typeof parsed.name !== 'string' || !Object.prototype.hasOwnProperty.call(parsed, 'arguments')) {
        return { calls: [], bare: false };
    }

    const result = coerceToolCall(raw, allowedToolNames);
    if (!result.call) {
        return { calls: [], bare: true, reason: result.error, error: result };
    }
    return { calls: [result.call], bare: true, recoveredJson: result.recovered };
}

function parseToolCallsDetailed(text, opts = {}) {
    const source = String(text || '');
    const allowedToolNames = opts.allowedToolNames || null;
    const hadToolCallMarkup = /<tool_call\b/i.test(stripCodeContexts(source));

    const exact = parseExactToolCalls(source, allowedToolNames);
    if (exact.calls.length > 0) {
        return { calls: exact.calls, repaired: false, hadToolCallMarkup, errors: exact.errors, recoveredJson: exact.recoveredJson };
    }

    if (!hadToolCallMarkup) {
        const bare = parseBareToolCallJson(source, allowedToolNames);
        if (bare.calls.length > 0) {
            return {
                calls: bare.calls,
                repaired: false,
                hadToolCallMarkup: false,
                hadBareToolCallJson: true,
                errors: exact.errors,
                recoveredJson: !!bare.recoveredJson,
            };
        }
        if (bare.bare) {
            return {
                calls: [],
                repaired: false,
                hadToolCallMarkup: false,
                hadBareToolCallJson: true,
                malformedReason: bare.reason,
                errors: exact.errors.concat(bare.error ? [bare.error] : []),
            };
        }
        return { calls: [], repaired: false, hadToolCallMarkup: false, hadBareToolCallJson: false, errors: exact.errors };
    }

    const malformed = parseMalformedToolCall(source, allowedToolNames);
    return {
        calls: malformed.calls,
        repaired: malformed.repaired,
        hadToolCallMarkup,
        malformedReason: malformed.reason,
        closeTag: malformed.closeTag,
        errors: exact.errors.concat(malformed.error ? [malformed.error] : []),
        recoveredJson: !!malformed.recoveredJson,
    };
}

function parseToolCalls(text, allowedToolNames) {
    return parseToolCallsDetailed(text, { allowedToolNames }).calls;
}

function hasInternalBridgeMarkup(text) {
    if (!text) return false;
    return /<(?:tool_call|tool_result|tool_thinking|previous_response)\b|<\/(?:tool_call|tool_char|tool_result|tool_thinking|previous_response)>/i.test(stripCodeContexts(String(text)));
}

function redactSensitivePreview(text, maxLen = 400) {
    if (!text) return '';
    return String(text)
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-***')
        .replace(/\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|DEEPSEEK_API_KEY)\b\s*[:=]\s*[^\s"']+/gi, '$1=***')
        .replace(/\b(token|api[_-]?key|secret|password)\b\s*[:=]\s*[^\s,}\]"']+/gi, '$1=***')
        .slice(0, maxLen)
        .replace(/\n/g, '\\n');
}

function cleanResponseText(text) {
    if (!text) return text;
    const stripped = String(text)
        .replace(/<tool_thinking\b[^>]*>[\s\S]*?<\/tool_thinking>/g, '')
        .replace(/<tool_call\b[^>]*>[\s\S]*?<\/(?:tool_call|tool_char)>/g, '')
        .replace(/<tool_call\b[^>]*>[\s\S]*$/g, '')
        .replace(/<tool_result\b[^>]*>[\s\S]*?<\/tool_result>/g, '')
        .replace(/<previous_response\b[^>]*>[\s\S]*?<\/previous_response>/g, '')
        .replace(/<tool_result\b[^>]*>[\s\S]*?<\/tool_call>/g, '')
        .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_result>/g, '')
        .replace(/<tool_thinking\b[^>]*>[\s\S]*?<\/tool_call>/g, '')
        .replace(/<tool_thinking\b[^>]*>[\s\S]*?<\/tool_result>/g, '')
        .replace(/<\/?(?:tool_thinking|tool_call|tool_result|previous_response)\b[^>]*>/g, '');
    const parts = stripped.split(/(```[\s\S]*?```)/);
    return parts
        .map((part, idx) => idx % 2 === 0 ? part.replace(/\n{3,}/g, '\n\n') : part)
        .join('')
        .trim();
}

module.exports = {
    cleanResponseText,
    extractBalancedJsonObjects,
    hasInternalBridgeMarkup,
    parseToolCalls,
    parseToolCallsDetailed,
    redactSensitivePreview,
    stripCodeContexts,
};
