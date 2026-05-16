# Architecture Deep Dive

This document covers the internal architecture of openclaw-claude-bridge — how sessions work, how messages are translated, how tool calling is implemented, and how state is managed.

For setup and usage, see the [README](../README.md).

---

## Table of Contents

- [Request Lifecycle](#request-lifecycle)
- [Message Translation](#message-translation)
- [Session Management](#session-management)
- [Tool Calling Protocol](#tool-calling-protocol)
- [Token Usage and Caching](#token-usage-and-caching)
- [Context Refresh](#context-refresh)
- [CLI Flag Strategy](#cli-flag-strategy)
- [Process Lifecycle](#process-lifecycle)
- [State Persistence](#state-persistence)
- [Concurrency Control](#concurrency-control)
- [Dashboard](#dashboard)
- [Security Model](#security-model)

---

## Request Lifecycle

Every request to `POST /v1/chat/completions` goes through these stages:

```
1. INTERCEPT     Is this a memory flush or /new startup? → return NO_REPLY
2. IDENTIFY      Extract routing signals + agent name → build routing key
3. QUEUE/LIMIT   Serialize same-route work and check the global concurrent limit
4. SESSION       Map lookup/fallback routing → resume existing or create new
5. TRANSLATE     Convert OpenAI messages → Claude CLI text format
6. SPAWN         Launch claude --print subprocess, pipe prompt via stdin
7. PARSE         Read stream-json events, collect text + usage
8. RESPOND       Parse <tool_call> blocks → OpenAI tool_calls or clean text
9. PERSIST       Update channelMap, responseMap, save state.json
```

### Interception (Step 1)

Two types of requests are intercepted before reaching Claude:

- **Memory/cache maintenance** (explicit no-tool maintenance marker): OpenClaw can send a tools-less upkeep turn during memory/cache maintenance. The bridge returns `NO_REPLY` only when the request carries an explicit maintenance marker, such as the compaction-summary prefix or OpenClaw memory-flush metadata — no CLI session is created.
- **/new startup**: The first request after a user runs `/new` in OC contains only a startup marker and no conversation metadata. The bridge returns `NO_REPLY` and waits for the real request that follows.

A plain `tools: []` request is not enough to trigger this interception; ordinary no-tool chats still follow normal Claude routing.

### Identity Extraction (Step 2)

The bridge extracts stable routing signals from the request, in priority order. Trusted OpenClaw transport/context signals outrank user-visible prompt metadata, so a spoofed `Conversation info` block cannot override a stable trusted route:

1. **`x-openclaw-session-key`**: HTTP header used by transports that preserve custom provider headers.
2. **Inbound Context**: Parsed from the `Inbound Context (trusted metadata)` block when custom headers are dropped.
3. **Conversation label**: Parsed from the `Conversation info (untrusted metadata)` JSON block in user messages. Format: `Guild #channel-name` for group chats, `dm:username` for DMs. This is a legacy fallback only when no trusted OpenClaw route signal is present.
4. **`prompt_cache_key`**: OpenAI-style request field used as a routing fallback for OpenClaw subagent/cron flows where the agent session id is carried there.
5. **`user`**: Final fallback for raw OpenAI-compatible clients.

The agent name is parsed from the `**Name:** AgentName` field in developer/system messages. When the active routing signal represents a conversation surface, the routing key includes the agent name so agents sharing a channel each get their own independent CLI session.

---

## Message Translation

The bridge converts OpenAI message format into plain text that Claude CLI accepts via stdin (`convert.js`).

### Role Mapping

| OpenAI Role | Claude CLI Format |
|---|---|
| `developer` / `system` | Combined into `--system-prompt` argument |
| `user` | `User: {content}` |
| `assistant` (text only) | Wrapped in `<previous_response>...</previous_response>` |
| `assistant` (with tool_calls) | Tool calls formatted as `<tool_call>` XML inside `<previous_response>` |
| `tool` | `<tool_result name="..." tool_call_id="...">...</tool_result>` |

### Content Extraction

Messages may contain either a plain string or an array of content parts (OpenAI's multimodal format). The bridge extracts text parts and joins them, ignoring non-text content.

### System Prompt Construction

The final system prompt sent to Claude CLI is:

```
{developer/system messages joined by double newline}

---

## Tool Calling Protocol

When you need to use a tool, output EXACTLY this format...

Available tools:
- **tool_name**: description
- ...
```

The `--system-prompt` flag replaces Claude Code's default system prompt (~15-20KB), which would otherwise include instructions for native tools that are disabled via `--tools ""`.

---

## Session Management

### Session Lookup

When a request arrives, the bridge first selects a routing key from the request signals above. It then tries to find an existing CLI session to resume in this order:

```
                    ┌─────────────────────┐
                    │  Incoming request    │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
              ┌─ Y ─│ 1. channelMap has    │
              │     │    routingKey?        │
              │     └──────────┬──────────┘
              │                │ N
              │     ┌──────────▼──────────┐
              │ ┌ Y ─│ 2. sessionMap has    │
              │ │    │    tool_call_id?     │
              │ │    └──────────┬──────────┘
              │ │               │ N
              │ │    ┌──────────▼──────────┐
              │ │┌ Y ─│ 3. responseMap has  │
              │ ││   │    assistant text?   │
              │ ││   └──────────┬──────────┘
              │ ││              │ N
              │ ││   ┌──────────▼──────────┐
              │ ││   │  Create new session  │
              │ ││   └─────────────────────┘
              │ ││
              ▼ ▼▼
        ┌─────────────────────┐
        │  Resume session     │
        │  (send only new     │
        │   messages)         │
        └─────────────────────┘
```

**Tier 1 — channelMap** (primary):
- Key: the selected routing source + label (for example `conversationLabel:channel::agent`, `inboundContext:telegram:private::agent`, or `promptCacheKey:<session-id>`)
- Purpose: Stable session routing for normal channels, header-preserving transports, trusted inbound metadata, OpenClaw subagent/cron flows, and raw OpenAI clients
- Populated after every successful response

**Tier 2 — sessionMap** (tool loop):
- Key: `tool_call_id` from the previous response
- Purpose: When OC sends tool results back, the bridge links them to the correct CLI session
- Populated when Claude's response contains tool calls

**Tier 3 — responseMap** (last fallback):
- Key: First 200 characters of distinctive assistant response text
- Purpose: Last-resort fallback when the structured routing signals and tool-call id do not identify the session
- Collision-prone short or sentinel responses such as `NO_REPLY`, `HEARTBEAT_OK`, and `[DONE]` are ignored instead of stored or matched

### Resume vs. New Session

When resuming, the bridge sends only the new messages (since the last assistant response) to Claude CLI via stdin. The CLI session file already contains the full conversation history, so this avoids re-processing the entire context.

Two extraction strategies:

1. **`extractNewMessages`** — Used during tool loops. Finds the last assistant message with `tool_calls` and sends everything after it (tool results + any new user messages).
2. **`extractNewUserMessages`** — Used for simple conversation continuation. Finds the last assistant message and sends everything after it.

If neither strategy finds new content, the bridge falls back to creating a new session with the full conversation history.

### /new Detection

When a user runs `/new` in OpenClaw, the bridge detects this by looking for the "New session started" marker in assistant messages. When detected:

1. The old CLI session is purged (in-memory maps cleaned + session file deleted from disk)
2. The channelMap entry is removed
3. A fresh CLI session is created

---

## Tool Calling Protocol

### How It Works

Since Claude's native tools are disabled (`--tools ""`), the bridge injects custom tool-calling instructions into the system prompt (`tools.js`). These instructions tell Claude to output `<tool_call>` XML blocks when it needs a tool.

```
Claude's output:

I'll search for that information.

<tool_call>
{"name": "web_search", "arguments": {"query": "bitcoin price today"}}
</tool_call>
```

The bridge parses these blocks (`parseToolCalls` in `src/tool-parser.js`) and converts them into OpenAI's `tool_calls` format:

```json
{
  "tool_calls": [{
    "id": "call_a1b2c3d4",
    "type": "function",
    "function": {
      "name": "web_search",
      "arguments": "{\"query\": \"bitcoin price today\"}"
    }
  }],
  "finish_reason": "tool_calls"
}
```

### Blocked Tools

Certain OC-internal tools are blocked from appearing in Claude's available tools list:

- `sessions_send` — OC session management
- `sessions_spawn` — OC session spawning
- `gateway` — OC gateway control

These are infrastructure tools that Claude should never call.

### Response Cleaning

Before sending text to the user, the bridge strips internal XML tags that Claude may echo:

- `<tool_call>...</tool_call>` — removed (already parsed into tool_calls)
- `<tool_result>...</tool_result>` — removed (conversation context, not for users)
- `<previous_response>...</previous_response>` — removed (conversation context)

---

## Token Usage and Caching

### Usage Reporting

The bridge reports token usage in OpenAI-compatible format:

| OpenAI Field | Source | Description |
|---|---|---|
| `prompt_tokens` | `input_tokens` + `cache_creation_tokens` + `cache_read_tokens` | Total input |
| `completion_tokens` | `output_tokens` | Output tokens |
| `prompt_tokens_details.cached_tokens` | `cache_read_input_tokens` | Tokens read from cache |
| `prompt_tokens_details.cache_creation_tokens` | `cache_creation_input_tokens` | Tokens written to cache |

### Prompt Caching

Anthropic's prompt caching automatically caches repeated prompt prefixes. When resuming a session:

- The system prompt (developer messages + tool instructions) is usually identical across turns
- The CLI session contains the conversation history on disk
- Only new messages are sent via stdin

This means most of the context is cache-read (0.1x cost) rather than reprocessed. The dashboard displays cache hit rates per request.

---

## Context Refresh

When OpenClaw compacts a conversation (replacing old messages with a summary), the bridge detects this and synchronises the CLI session.

### Detection

OC's compaction messages start with a known prefix:
```
The conversation history before this point was compacted into the following summary:
```

The bridge hashes the first 500 characters and compares it against the stored hash for that channel. If different, a compaction has occurred.

### Refresh Process

1. The old CLI session is purged
2. A new session is created with a **compact** version of the conversation
3. `convertMessagesCompact` truncates old messages:
   - Assistant text: capped at 1,500 characters
   - Recent tool results (last 10 turns): capped at 2,000 characters
   - Old tool results: capped at 500 characters
4. The compaction hash is stored to prevent re-triggering

If the compact prompt exceeds 1,500,000 characters, the refresh is skipped to avoid overwhelming the CLI.

Context refresh is deferred if a tool loop is in progress — the bridge waits until the tool loop completes before refreshing.

---

## CLI Flag Strategy

The bridge strips Claude Code CLI down to a clean, minimal language model — no default behaviours, no built-in tools, no preset system prompt. Every flag serves a specific purpose.

### Complete Flag Breakdown

```bash
claude --print \
  [--dangerously-skip-permissions] \
  --output-format stream-json \
  --verbose \
  --model opus \
  --session-id <uuid> \          # or --resume <uuid>
  --system-prompt "<prompt>" \   # REPLACES default, not appends
  --tools ""                     # disables ALL native tools
```

| Flag | What it does | Why we use it |
|---|---|---|
| `--print` | Non-interactive mode — read stdin, write stdout, exit | Bridge is a headless proxy, no terminal |
| `--output-format stream-json` | Structured JSON events instead of raw text | Lets us parse token usage, result events, and errors programmatically |
| `--verbose` | Include detailed events in the stream | Captures thinking status, tool activity for the dashboard |
| `--model <alias>` | Select Claude model (opus/sonnet/haiku) | Passed on every invocation; not persisted in session |
| `--session-id <uuid>` | Create a new session with a specific ID | Bridge controls session lifecycle, not the CLI |
| `--resume <uuid>` | Resume an existing session | Conversation history already on disk; only new messages sent via stdin |
| `--system-prompt` | **Replace** the default system prompt entirely | See below |
| `--tools ""` | Disable all native tools (Bash, Read, Write, Edit, WebSearch, etc.) | See below |
| `--dangerously-skip-permissions` | Skip interactive confirmation prompts | Opt-in only via `OPENCLAW_BRIDGE_CLAUDE_SKIP_PERMISSIONS=1` for trusted local sandbox/headless deployments that knowingly need it |

### System Prompt Replacement (`--system-prompt`)

This is the single most important flag for the bridge's architecture.

Claude Code CLI ships with a default system prompt of ~15-20KB. This prompt instructs Claude on how to use its native tools — Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, and many others. It includes detailed instructions for each tool, safety guidelines, output formatting rules, and more.

**The problem:** We disable all native tools with `--tools ""`, but the default system prompt still tells Claude to use them. This creates contradictory instructions — Claude is told "use Bash to run commands" but Bash doesn't exist. The result is confused behaviour, wasted context window, and occasional attempts to use non-existent tools.

**The solution:** `--system-prompt` completely replaces the default prompt with our own. The bridge constructs a clean system prompt containing only:

1. OpenClaw's developer/system messages (agent identity, conversation rules)
2. The dynamically generated tool-calling protocol (available tools + `<tool_call>` format)

Nothing else. No instructions for tools that don't exist. No formatting rules we don't need. Claude receives exactly the context it needs to function as a translation proxy.

**History:** The bridge originally used `--append-system-prompt`, which *added* our instructions after the default prompt. This meant every request carried ~15-20KB of irrelevant noise. Switching to `--system-prompt` eliminated this — a ~15-20KB reduction per request that also removed the contradictory tool instructions.

### Native Tool Disabling (`--tools ""`)

Passing an empty string to `--tools` disables every built-in tool:

- **Shell execution:** Bash, terminal commands
- **File operations:** Read, Write, Edit, Glob, Grep
- **Web access:** WebSearch, WebFetch
- **All others:** NotebookEdit, TodoWrite, Agent, etc.

With tools disabled, Claude can only output text. When it needs to perform an action, it outputs `<tool_call>` XML blocks (as instructed by our system prompt), which the bridge parses and forwards to OpenClaw's gateway. OpenClaw executes the tools and sends results back.

This is the foundation of the security model — Claude cannot execute anything on the host machine.

### The Combined Effect

Together, `--system-prompt` and `--tools ""` turn Claude Code CLI into a pure language model endpoint:

```
Default Claude Code CLI:
  ┌─────────────────────────────────┐
  │  ~15-20KB default system prompt │  ← instructions for native tools
  │  Built-in tools (Bash, Read...) │  ← can execute on host
  │  Permission prompts             │  ← needs terminal
  └─────────────────────────────────┘

Bridge's Claude Code CLI:
  ┌─────────────────────────────────┐
  │  Our system prompt only         │  ← agent identity + tool protocol
  │  No tools                       │  ← text output only
  │  Optional prompt skipping       │  ← opt-in for trusted headless deployments
  └─────────────────────────────────┘
```

The CLI is effectively reduced to: "accept text in, produce text out, with session persistence."

---

## Process Lifecycle

### Claude CLI Subprocess

By default, each request spawns a Claude CLI subprocess using the flags described above.

The subprocess runs with `cwd=/tmp` and receives the conversation prompt via stdin.

### Phase 1 Live Claude Process (Experimental)

`OPENCLAW_BRIDGE_CLAUDE_LIVE=1` enables the Phase 1 live-process path. Instead of spawning a process for every request, the bridge keeps one stream-json Claude process per bridge session and serializes turns through that process.

Phase 1 stays inside the existing security boundary: the live process uses the same model, system prompt, `--tools ""`, and `--strict-mcp-config` isolation as the per-request path; OpenClaw remains the only tool executor. If those process arguments change, the bridge stops the old live process and starts a new one.

Idle live processes are shut down after `OPENCLAW_BRIDGE_CLAUDE_LIVE_IDLE_MS`; the default is `600000` ms (10 minutes). This live idle shutdown is separate from the active-request stdout idle timeout below.

### Timeouts

| Type | Duration | Purpose |
|---|---|---|
| **Active-request idle timeout** | 2 min (configurable with `IDLE_TIMEOUT_MS`) | Kill if no stdout activity for this long during an active request. Reset on every output chunk. |
| **Live process idle shutdown** | 10 min (configurable with `OPENCLAW_BRIDGE_CLAUDE_LIVE_IDLE_MS`) | Stop an opt-in Phase 1 live Claude process after this many ms with no requests. |
| **Hard timeout** | 20 min (configurable with `HARD_TIMEOUT_MS`) | Absolute maximum runtime regardless of activity for both per-request and live-mode active turns. |

The active-request idle timeout catches stuck processes while allowing long tool chains (which produce output) to continue. The hard timeout is a safety net for both default per-request runs and opt-in live-mode turns that keep producing output but never finish.

### Client Disconnect

When OpenClaw disconnects mid-request (timeout, restart, etc.), the bridge:

1. Receives a `close` event on the response stream
2. Triggers the `AbortController`, which sends `SIGTERM` to the Claude CLI subprocess
3. Follows up with `SIGKILL` after 3 seconds if still alive
4. If this was a resume, the session is preserved (not purged) so the next request can continue

### Graceful Shutdown

On `SIGTERM` or `SIGINT`:

1. Save state to `state.json`
2. Stop accepting new connections
3. Wait for all active requests to complete (checked every 5 seconds)
4. Exit cleanly

The idle timeout in `claude.js` ensures stuck requests eventually terminate. For systemd, `TimeoutStopSec=600` provides the ultimate safety net.

---

## State Persistence

### What's Saved

`state.json` is written after every completed request and during shutdown:

```json
{
  "schemaVersion": 1,
  "stats": {
    "totalRequests": 142,
    "errors": 3
  },
  "channelMap": [
    ["#general::researcher", { "sessionId": "abc-123", "createdAt": 1709900000000 }]
  ],
  "responseMap": [
    ["I found the following results...", { "sessionId": "abc-123", "createdAt": 1709900000000 }]
  ],
  "requestLog": [...],
  "globalActivity": [...]
}
```

### Write Safety

State is written atomically using the rename pattern:
1. Write to `state.json.tmp`
2. Rename `state.json.tmp` → `state.json`

This prevents corruption if the process crashes mid-write.

### Load, Migrate, and Prune

On startup:
1. Load `state.json` if it exists
2. Read `schemaVersion`; legacy unversioned state is migrated in memory, while unknown future versions load compatible fields only
3. For each channelMap, sessionMap, and responseMap entry, verify the CLI session file still exists on disk
4. Prune entries where the session file is gone, and drop unsafe responseMap keys such as short/sentinel values
5. Restore requestLog (last 200) and globalActivity (last 50)

### Session Files

CLI session files are stored at:
```
~/.claude/projects/-private-tmp/<session-id>.jsonl
```

On macOS, `/tmp` is a symlink to `/private/tmp`, so the bridge uses `fs.realpathSync('/tmp')` to resolve the correct path.

Sessions older than 24 hours are automatically deleted on startup. Manual dashboard cleanup via `POST /cleanup` is disabled unless `DASHBOARD_PASS` is set; when enabled, it requires Basic Auth plus an explicit API-intent header (`X-OpenClaw-Bridge-CSRF: cleanup` or `X-Requested-With: OpenClawBridge`).

---

## Concurrency Control

### Per-Channel Serialization

Requests for the same routing key are serialized one-at-a-time before they touch Claude CLI session state. This preserves request order and prevents two concurrent turns from racing against the same Claude session. There is no `MAX_PER_CHANNEL` knob; older docs/env examples that mentioned it were stale.

### Global Limit

A global maximum of 20 concurrent requests (`MAX_GLOBAL`) acts as a safety net across all channels. When the global limit is hit, requests receive HTTP 429 with a descriptive error message.

### Memory Garbage Collection

The `sessionMap` and `responseMap` entries are garbage-collected after 1 hour (`MEMORY_GC_TTL_MS`). This prevents memory leaks from accumulated tool_call_ids and response keys.

---

## Dashboard

The bridge includes a React SPA dashboard (built with TypeScript, Tailwind CSS, and Vite) served from port 3458. It polls the `/status` endpoint every 3 seconds for live data.

![Dashboard screenshot](dashboard-screenshot.png)

### Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  Header: status · uptime · requests · active · cost · sessions  │
│          errors · tools · last refresh · dark/light toggle       │
├──────────┬──────────────────────────────────────────────────────┤
│          │  Live Activity                                       │
│  Agent   │  ┌─────────────────────────────────────────────────┐ │
│  Sidebar │  │ 3s  🧠 Thinking (5 tools)                      │ │
│          │  │ 12s 🔧 Tools: web_search, memory_search         │ │
│  ● All   │  │ 25s ✅ Done (2.3s)                              │ │
│  ● Agent1│  │ 1m  🔄 Resuming (1.2K chars)                   │ │
│  ● Agent2│  └─────────────────────────────────────────────────┘ │
│          │                                                      │
│          │  Sessions / Agent1                                   │
│          │  ┌──────┬──────┬──────┬──────┐                       │
│          │  │ ctx  │ ctx  │ ctx  │ ctx  │  ← context cards      │
│          │  │ 42%  │ 18%  │ 67%  │ 5%   │                       │
│          │  └──────┴──────┴──────┴──────┘                       │
│          │  ┌───────────────────────────────────────────────┐   │
│          │  │ Time  Chan  Sess  Resume  Model  In  Out Cost │   │
│          │  │ 14:32 #gen  a1b2  🔧Tools opus  12K 3K $0.01 │   │
│          │  │ 14:30 #dev  c3d4  💬Chat  snnt  8K  2K $0.00 │   │
│          │  │ ...                                           │   │
│          │  └───────────────────────────────────────────────┘   │
└──────────┴──────────────────────────────────────────────────────┘
```

The layout is responsive — on mobile, the sidebar collapses into a horizontal pill bar at the top.

### Header Bar

A single-line status bar across the top showing:

| Metric | Description |
|---|---|
| Status | Online/Offline indicator with green pulse dot |
| Uptime | Time since last restart |
| Requests | Total request count (persisted across restarts) |
| Active | Currently in-flight requests |
| Total Cost | Sum of all logged request costs (USD) |
| Sessions | CLI session file count + disk size |
| Errors | Total error count |
| Tools | Number of OC tools available (from latest request) |

Also includes a dark/light theme toggle (persisted to localStorage) and a refresh timestamp.

### Agent Sidebar

Lists all agents that have made requests, sorted by most recent activity. Each agent entry shows:

- **Activity dot**: Green (active in last 5 min), amber (last 30 min), gray (inactive)
- **Agent name**
- **Last active time**
- **Stats**: session count, request count, total cost

Selecting an agent filters all other panels to show only that agent's data. "All Agents" shows everything.

On mobile, this becomes a horizontal scrollable pill bar with the same information.

### Live Activity Feed

A real-time event stream showing the last 50 events. Raw server messages are parsed and reformatted with emoji indicators:

| Emoji | Event Type |
|---|---|
| 🧠 | Thinking (new request started) |
| 🔧 | Tool calls requested |
| 🔄 | Session resumed |
| ♻️ | Context refresh triggered |
| 🧹 | Explicit memory/cache maintenance intercepted |
| ✅ | Request completed |
| ⚠️ | Retry after CLI error |
| ❌ | Error |

Each event shows a relative timestamp (e.g. "3s", "2m") and, in "All Agents" view, the agent name and channel.

The feed is collapsible — shows the 4 most recent events by default with a "+N more" expander.

### Context Cards

A row of mini cards showing per-session context window usage. Each card displays:

- **Session ID** (color-coded — each session gets a unique color from a 12-color palette)
- **Agent name**
- **Progress bar**: Visual representation of context usage
- **Percentage + token counts**: e.g. "42% · 84K / 1.0M"
- **Request count + cost**: e.g. "5 req · $0.0142"

Progress bar colors follow traffic-light convention:
- **Green** (<40%): Plenty of context remaining
- **Amber** (40–65%): Getting full
- **Red** (>65%): Approaching limit

Up to 5 sessions are shown; older sessions are collapsed with a "+N older" indicator.

### Request Table

The main data table showing every request, with 13 columns:

| Column | Description |
|---|---|
| Time | Request timestamp |
| Channel | Discord channel or DM identifier |
| Session | CLI session ID (color-coded, ↩ for resumed, ⊕ for new) |
| Resume | How the session was resolved (see below) |
| Prompt | Prompt size sent to CLI |
| Model | Claude model used (opus/sonnet/haiku) |
| Think | Thinking level (off/low/medium/high) |
| In | Total input tokens |
| Out | Output tokens |
| Cost | Per-request cost (USD) |
| Cache | Cache hit rate (% of input from Anthropic prompt cache) |
| Duration | Request processing time |
| Status | ok (green), error (red), or pending (amber) |

**Resume methods** are emoji-coded for quick scanning:

| Badge | Method | Meaning |
|---|---|---|
| 🔧 Tools | `tool_loop` | Continuing a tool-calling sequence |
| 💬 Chat | `continuation` | Simple conversation follow-up |
| 🆕 New | `newstart` | Fresh session from OC /new |
| 🧹 Flush | `memflush` | Explicit memory/cache maintenance intercepted (no CLI call) |
| ♻️ Refresh | `refresh` | Context refresh after OC compaction |
| ⚠️ Fallback | `fallback` | Resume failed, fell back to new session |
| ▶️ Initial | — | First request (no prior session) |

Each row is expandable — clicking the triangle reveals the request's activity log (tool calls made, files read, etc.) and any error details.

**Filters**: The table supports two filter types:
- **Channel filter** (in "All Agents" view): Show only requests from a specific channel
- **Resume method filter**: Show only requests with a specific resume method

**Pagination**: Tables with more than 25 rows are paginated with page number navigation.

### Session Cleanup

A "🧹 Clean Sessions" button in the Sessions section header triggers `POST /cleanup`, which deletes CLI session files older than 24 hours. The endpoint is disabled unless `DASHBOARD_PASS` is set, and requires Basic Auth plus an explicit API-intent header when enabled. The dashboard refreshes automatically after cleanup.

### Tech Stack

| Component | Technology |
|---|---|
| Framework | React 19 |
| Language | TypeScript |
| Styling | Tailwind CSS |
| Build | Vite |
| Data | Polling `/status` every 3s (no WebSocket) |
| Themes | Dark/Light (CSS classes, localStorage) |
| State | React hooks (`useState`, `useMemo`, `useCallback`) |

The dashboard is built to `dashboard/dist/` and served as static files by the Express status server. No separate process needed.

During Vite development, `/status` and `/cleanup` are proxied to `VITE_STATUS_API_TARGET`, which defaults to `http://127.0.0.1:3458`.

---

## Security Model

### Network Isolation

- **Port 3456** (API): Bound to `127.0.0.1` — only accessible from the same machine. OpenClaw's gateway connects locally.
- **Port 3458** (Dashboard/status): Bound to `127.0.0.1` by default. Set `OPENCLAW_BRIDGE_STATUS_BIND` to a non-loopback interface only when you want LAN exposure; the bridge refuses to start in that mode unless `DASHBOARD_PASS` is set.
- **`/cleanup`**: Disabled unless `DASHBOARD_PASS` is set, and requires Basic Auth plus `X-OpenClaw-Bridge-CSRF: cleanup` or `X-Requested-With: OpenClawBridge` when enabled.

### Tool Isolation

`--tools ""` disables all Claude native tools (Bash, Read, Write, Edit, WebSearch, etc.). Claude cannot execute any commands on the host. All tool execution goes through OpenClaw's controlled gateway.

### Optional `--dangerously-skip-permissions`

Claude Code CLI may prompt for confirmation before taking actions. The bridge does **not** pass `--dangerously-skip-permissions` by default. Operators can opt in with `OPENCLAW_BRIDGE_CLAUDE_SKIP_PERMISSIONS=1` for trusted local sandbox/headless deployments that knowingly need non-interactive permission behavior.

Do not treat this as a blanket safety guarantee: native Claude tools remain disabled with `--tools ""`, and tool execution is still delegated to OpenClaw, but the flag intentionally lowers Claude CLI's own permission prompt barrier.

### Secrets

- `DASHBOARD_PASS` is stored in `.env` (gitignored)
- No secrets appear in logs or state.json
