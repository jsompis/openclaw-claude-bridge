'use strict';

// Gateway-internal tools that should not be listed as available to Claude.
// These are OC infrastructure tools, not user-facing.
const GATEWAY_BLOCKED = new Set(['sessions_send', 'sessions_spawn', 'gateway']);

/**
 * Build tool instructions for the system prompt.
 *
 * In the new architecture, Claude does NOT execute tools.
 * Instead, it outputs <tool_call> blocks which we parse and return
 * to OpenClaw as standard OpenAI tool_calls.
 * OpenClaw executes the tools and sends results back.
 */
function buildToolInstructions(tools) {
    if (!tools || tools.length === 0) return '';

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

    for (const tool of tools) {
        const name = tool.function?.name || tool.name;
        if (!name) continue;
        if (GATEWAY_BLOCKED.has(name)) continue;
        const desc = tool.function?.description || tool.description || '';
        lines.push(`- **${name}**: ${desc}`);
    }

    return lines.join('\n');
}

module.exports = { buildToolInstructions };
