'use strict';

function toolName(tool) {
    return tool?.function?.name || tool?.name || '';
}

function isBridgeAllowedToolName(name) {
    return Boolean(name);
}

function filterBridgeAllowedTools(tools) {
    if (!Array.isArray(tools)) return [];
    return tools.filter(tool => isBridgeAllowedToolName(toolName(tool)));
}

function bridgeAllowedToolNames(tools) {
    return new Set(filterBridgeAllowedTools(tools).map(toolName).filter(Boolean));
}

function truncateDescription(value, max = 120) {
    if (typeof value !== 'string') return undefined;
    const compact = value.replace(/\s+/g, ' ').trim();
    if (!compact) return undefined;
    return compact.length > max ? compact.slice(0, max - 1) + '…' : compact;
}

function compactSchemaValue(value, depth = 0) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) return undefined;

    const out = {};
    for (const key of ['type', 'format', 'minimum', 'maximum', 'minLength', 'maxLength']) {
        if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = value[key];
    }
    if (Array.isArray(value.enum) && value.enum.length <= 12) out.enum = value.enum;
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

    return Object.keys(out).length > 0 ? out : undefined;
}

function compactToolSchema(tool, maxLen = 900) {
    const schema = tool?.function?.parameters || tool?.parameters;
    const compact = compactSchemaValue(schema);
    if (!compact) return '';
    const json = JSON.stringify(compact);
    return json.length > maxLen ? json.slice(0, maxLen - 1) + '…' : json;
}

function stripUpstreamToolingSection(systemPrompt) {
    const source = String(systemPrompt || '');
    const marker = /^## Tooling\s*$/m;
    const match = marker.exec(source);
    if (!match) return source;

    const before = source.slice(0, match.index).replace(/\n{3,}$/g, '\n\n');
    const afterStart = match.index + match[0].length;
    const rest = source.slice(afterStart);
    const nextSection = rest.search(/^## (?!Tooling\s*$).+/m);
    if (nextSection === -1) return before.trimEnd();
    const after = rest.slice(nextSection).replace(/^\n+/, '');
    return `${before}${before && after ? '\n\n' : ''}${after}`.trimEnd();
}

/**
 * Build tool instructions for the system prompt.
 *
 * In the new architecture, Claude does NOT execute tools.
 * Instead, it outputs bridge tool-call envelopes which we parse and return
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
        '## Bridge Tool Calling Protocol',
        '',
        'When you need a tool, emit exactly one or more bridge tool-call envelopes and then stop. Do not execute tools yourself.',
        'Envelope body JSON shape: {"name":"tool_name","arguments":{"key":"value"}}',
        'The orchestrator will execute allowed tool calls and send results back.',
        '',
        'Available tools (OpenClaw request allowlist is source of truth):',
    ];

    for (const tool of allowedTools) {
        const name = toolName(tool);
        const desc = truncateDescription(tool.function?.description || tool.description || '');
        const schema = compactToolSchema(tool);
        lines.push(`- ${name}${desc ? `: ${desc}` : ''}${schema ? ` args=${schema}` : ''}`);
    }

    return lines.join('\n');
}

module.exports = {
    bridgeAllowedToolNames,
    buildToolInstructions,
    compactToolSchema,
    filterBridgeAllowedTools,
    isBridgeAllowedToolName,
    stripUpstreamToolingSection,
};
