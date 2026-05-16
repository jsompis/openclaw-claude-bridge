'use strict';

// Gateway-internal tools that should not be listed as available to Claude or
// accepted back from bridge-emitted <tool_call> markup. These are OC
// infrastructure tools, not user-facing.
const GATEWAY_BLOCKED = new Set(['sessions_send', 'sessions_spawn', 'gateway']);

function toolName(tool) {
    return tool?.function?.name || tool?.name || '';
}

function isBridgeAllowedToolName(name) {
    return Boolean(name) && !GATEWAY_BLOCKED.has(name);
}

function filterBridgeAllowedTools(tools) {
    if (!Array.isArray(tools)) return [];
    return tools.filter(tool => isBridgeAllowedToolName(toolName(tool)));
}

function bridgeAllowedToolNames(tools) {
    return new Set(filterBridgeAllowedTools(tools).map(toolName).filter(Boolean));
}

function truncateDescription(value, max = 180) {
    if (typeof value !== 'string') return undefined;
    const compact = value.replace(/\s+/g, ' ').trim();
    if (!compact) return undefined;
    return compact.length > max ? compact.slice(0, max - 1) + '…' : compact;
}

function compactSchemaValue(value, depth = 0) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 5) return undefined;

    const out = {};
    for (const key of ['type', 'format', 'pattern', 'minimum', 'maximum', 'minLength', 'maxLength', 'default']) {
        if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = value[key];
    }
    if (value.description) out.description = truncateDescription(value.description);
    if (Array.isArray(value.enum) && value.enum.length <= 20) out.enum = value.enum;
    if (Array.isArray(value.required) && value.required.length > 0) out.required = value.required;

    if (value.properties && typeof value.properties === 'object' && !Array.isArray(value.properties)) {
        out.properties = {};
        for (const [propName, propSchema] of Object.entries(value.properties)) {
            const compactProp = compactSchemaValue(propSchema, depth + 1);
            out.properties[propName] = compactProp || {};
        }
    }

    if (value.items) {
        const compactItems = compactSchemaValue(value.items, depth + 1);
        if (compactItems) out.items = compactItems;
    }

    for (const unionKey of ['anyOf', 'oneOf', 'allOf']) {
        if (Array.isArray(value[unionKey])) {
            const compactUnion = value[unionKey]
                .map(item => compactSchemaValue(item, depth + 1))
                .filter(Boolean);
            if (compactUnion.length > 0) out[unionKey] = compactUnion;
        }
    }

    return Object.keys(out).length > 0 ? out : undefined;
}

function compactToolSchema(tool, maxLen = 1800) {
    const schema = tool?.function?.parameters || tool?.parameters;
    const compact = compactSchemaValue(schema);
    if (!compact) return '';
    const json = JSON.stringify(compact);
    return json.length > maxLen ? json.slice(0, maxLen - 1) + '…' : json;
}

/**
 * Build tool instructions for the system prompt.
 *
 * In the new architecture, Claude does NOT execute tools.
 * Instead, it outputs <tool_call> blocks which we parse and return
 * to OpenClaw as standard OpenAI tool_calls.
 * OpenClaw executes the tools and sends results back.
 */
function buildToolInstructions(tools) {
    const allowedTools = filterBridgeAllowedTools(tools);
    if (allowedTools.length === 0) return '';

    const lines = [
        '',
        '---',
        '',
        '## Tool Calling Protocol',
        '',
        'When you need to use a tool, output EXACTLY this format and then STOP:',
        '',
        '<tool_call>',
        '{"name": "tool_name", "arguments": {"key": "value"}}',
        '</tool_call>',
        '',
        'You may request multiple tools at once:',
        '',
        '<tool_call>',
        '{"name": "web_search", "arguments": {"query": "bitcoin price"}}',
        '</tool_call>',
        '<tool_call>',
        '{"name": "memory_search", "arguments": {"query": "user preferences"}}',
        '</tool_call>',
        '',
        'CRITICAL RULES:',
        '- Do NOT execute tools yourself. Do NOT use Bash, Read, Write, Edit, WebSearch, WebFetch, Glob, Grep, or any native tools.',
        '- Output <tool_call> blocks and STOP. The orchestrator will execute them and provide results.',
        '- If you do not need any tools, just respond with your answer directly.',
        '- The conversation may already contain tool results from previous turns — use them, do not re-request.',
        '',
        'Available tools:',
    ];

    for (const tool of allowedTools) {
        const name = toolName(tool);
        const desc = tool.function?.description || tool.description || '';
        const schema = compactToolSchema(tool);
        lines.push(`- **${name}**: ${desc}${schema ? `\n  schema: ${schema}` : ''}`);
    }

    return lines.join('\n');
}

module.exports = {
    bridgeAllowedToolNames,
    buildToolInstructions,
    compactToolSchema,
    filterBridgeAllowedTools,
    isBridgeAllowedToolName,
};
