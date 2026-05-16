import { useState, useEffect, useCallback } from "react"
import type { StatusData } from "@/lib/types"

const POLL_INTERVAL = 3000
const USE_MOCK = false

const MOCK_DATA: StatusData = {
  status: "running",
  uptime: 14523,
  startedAt: new Date(Date.now() - 14523000).toISOString(),
  totalRequests: 847,
  activeRequests: 2,
  lastRequestAt: new Date(Date.now() - 12000).toISOString(),
  lastModel: "claude-sonnet-4-20250514",
  errors: 3,
  sessions: { count: 12, sizeKB: 2340 },
  channels: [
    { label: "\u{1F4CA} alpha-lab", sessionId: "sess-a1b2", age: 3600 },
    { label: "\u{1F3E0} General", sessionId: "sess-d4e5", age: 1800 },
    { label: "\u{1F527} dev-ops", sessionId: "sess-g7h8", age: 7200 },
    { label: "\u{1F4AC} random", sessionId: "sess-j0k1", age: 900 },
    { label: "dm:Alice", sessionId: "sess-m3n4", age: 5400 },
  ],
  activity: [
    { id: "req-f91a", at: Date.now() - 5000, msg: "Completed claude-sonnet-4-20250514 request (2.3s, $0.0142)" },
    { id: "req-e82b", at: Date.now() - 18000, msg: "Session resumed via tool_loop for \u{1F4CA} alpha-lab" },
    { id: "req-d73c", at: Date.now() - 45000, msg: "Cache hit 87% on continuation request" },
    { id: "req-c64d", at: Date.now() - 120000, msg: "New session started for \u{1F527} dev-ops channel" },
    { id: "req-b55e", at: Date.now() - 300000, msg: "Completed claude-sonnet-4-20250514 request (4.1s, $0.0298)" },
    { id: "req-a46f", at: Date.now() - 600000, msg: "Error: context window exceeded, triggering memflush" },
    { id: "req-937g", at: Date.now() - 900000, msg: "Session cleanup: removed 3 stale sessions" },
    { id: "req-828h", at: Date.now() - 1800000, msg: "Completed claude-sonnet-4-20250514 request (1.8s, $0.0087)" },
  ],
  log: [
    // --- alpha-lab: CryptoChief + MarketPulse ---
    {
      id: "req-f91a", at: new Date(Date.now() - 5000).toISOString(), model: "claude-sonnet-4-20250514",
      tools: 3, promptLen: 1200, inputTokens: 12400, cacheWriteTokens: 8200, cacheReadTokens: 89000,
      outputTokens: 3400, costUsd: 0.0142, durationMs: 2300, status: "ok", error: null,
      activity: ["Read file src/server.js", "Grep for handleRequest", "Edit src/handler.ts"],
      cliSessionId: "sess-a1b2c3", resumed: true, channel: "\u{1F4CA} alpha-lab", agent: "CryptoChief",
      effort: "medium", thinking: true, resumeMethod: "tool_loop",
    },
    {
      id: "req-e82b", at: new Date(Date.now() - 18000).toISOString(), model: "claude-sonnet-4-20250514",
      tools: 1, promptLen: 800, inputTokens: 8900, cacheWriteTokens: 3200, cacheReadTokens: 72000,
      outputTokens: 1800, costUsd: 0.0098, durationMs: 1800, status: "ok", error: null,
      activity: ["Write file config.yaml"],
      cliSessionId: "sess-a1b2c3", resumed: true, channel: "\u{1F4CA} alpha-lab", agent: "CryptoChief",
      effort: "low", thinking: false, resumeMethod: "continuation",
    },
    {
      id: "req-d73c", at: new Date(Date.now() - 45000).toISOString(), model: "claude-sonnet-4-20250514",
      tools: 5, promptLen: 2100, inputTokens: 18200, cacheWriteTokens: 12000, cacheReadTokens: 95000,
      outputTokens: 5200, costUsd: 0.0298, durationMs: 4100, status: "ok", error: null,
      activity: ["Read package.json", "Bash npm install", "Edit tsconfig.json", "Read vite.config.ts", "Write src/main.tsx"],
      cliSessionId: "sess-a1b2c3", resumed: true, channel: "\u{1F4CA} alpha-lab", agent: "CryptoChief",
      effort: "high", thinking: true, resumeMethod: "tool_loop",
    },
    {
      id: "req-mp01", at: new Date(Date.now() - 60000).toISOString(), model: "claude-sonnet-4-20250514",
      tools: 2, promptLen: 950, inputTokens: 10200, cacheWriteTokens: 4100, cacheReadTokens: 78000,
      outputTokens: 2600, costUsd: 0.0115, durationMs: 1900, status: "ok", error: null,
      activity: ["Read market-data.json", "Edit report.md"],
      cliSessionId: "sess-mp001", resumed: true, channel: "\u{1F4CA} alpha-lab", agent: "MarketPulse",
      effort: "medium", thinking: true, resumeMethod: "tool_loop",
    },
    {
      id: "req-mp02", at: new Date(Date.now() - 180000).toISOString(), model: "claude-sonnet-4-20250514",
      tools: 0, promptLen: 600, inputTokens: 6800, cacheWriteTokens: 6800, cacheReadTokens: 0,
      outputTokens: 1400, costUsd: 0.0072, durationMs: 1100, status: "ok", error: null,
      activity: [],
      cliSessionId: "sess-mp001", resumed: false, channel: "\u{1F4CA} alpha-lab", agent: "MarketPulse",
      effort: null, thinking: false, resumeMethod: "newstart",
    },
    {
      id: "req-a46f", at: new Date(Date.now() - 600000).toISOString(), model: "claude-sonnet-4-20250514",
      tools: 0, promptLen: 3000, inputTokens: 32000, cacheWriteTokens: 0, cacheReadTokens: 180000,
      outputTokens: 0, costUsd: 0.0180, durationMs: 8500, status: "error",
      error: "Context window exceeded (198K/200K). Triggering memflush and retry.",
      activity: [],
      cliSessionId: "sess-a1b2c3", resumed: true, channel: "\u{1F4CA} alpha-lab", agent: "CryptoChief",
      effort: "high", thinking: true, resumeMethod: "memflush",
    },
    {
      id: "req-937g", at: new Date(Date.now() - 900000).toISOString(), model: "claude-sonnet-4-20250514",
      tools: 4, promptLen: 900, inputTokens: 9800, cacheWriteTokens: 5400, cacheReadTokens: 67000,
      outputTokens: 2800, costUsd: 0.0130, durationMs: 2700, status: "ok", error: null,
      activity: ["Glob src/**/*.ts", "Read src/utils.ts", "Edit src/utils.ts", "Bash npm test"],
      cliSessionId: "sess-a1b2c3", resumed: true, channel: "\u{1F4CA} alpha-lab", agent: "CryptoChief",
      effort: "medium", thinking: true, resumeMethod: "tool_loop",
    },
    // --- General: Sentinel ---
    {
      id: "req-gen1", at: new Date(Date.now() - 90000).toISOString(), model: "claude-sonnet-4-20250514",
      tools: 2, promptLen: 1100, inputTokens: 11500, cacheWriteTokens: 5800, cacheReadTokens: 85000,
      outputTokens: 3100, costUsd: 0.0138, durationMs: 2100, status: "ok", error: null,
      activity: ["Read CHANGELOG.md", "Edit README.md"],
      cliSessionId: "sess-d4e5f6", resumed: true, channel: "\u{1F3E0} General", agent: "Sentinel",
      effort: "medium", thinking: true, resumeMethod: "continuation",
    },
    {
      id: "req-gen2", at: new Date(Date.now() - 240000).toISOString(), model: "claude-sonnet-4-20250514",
      tools: 3, promptLen: 1800, inputTokens: 16500, cacheWriteTokens: 9200, cacheReadTokens: 91000,
      outputTokens: 4800, costUsd: 0.0255, durationMs: 3600, status: "ok", error: null,
      activity: ["Glob src/**/*.ts", "Read src/index.ts", "Edit src/index.ts"],
      cliSessionId: "sess-d4e5f6", resumed: true, channel: "\u{1F3E0} General", agent: "Sentinel",
      effort: "high", thinking: true, resumeMethod: "tool_loop",
    },
    // --- dev-ops: DevBot ---
    {
      id: "req-dev1", at: new Date(Date.now() - 150000).toISOString(), model: "claude-sonnet-4-20250514",
      tools: 4, promptLen: 1400, inputTokens: 14200, cacheWriteTokens: 7100, cacheReadTokens: 88000,
      outputTokens: 3900, costUsd: 0.0195, durationMs: 2800, status: "ok", error: null,
      activity: ["Read Dockerfile", "Edit Dockerfile", "Bash docker build", "Read docker-compose.yml"],
      cliSessionId: "sess-g7h8i9", resumed: true, channel: "\u{1F527} dev-ops", agent: "DevBot",
      effort: "medium", thinking: true, resumeMethod: "tool_loop",
    },
    {
      id: "req-dev2", at: new Date(Date.now() - 420000).toISOString(), model: "claude-sonnet-4-20250514",
      tools: 0, promptLen: 500, inputTokens: 5200, cacheWriteTokens: 5200, cacheReadTokens: 0,
      outputTokens: 1500, costUsd: 0.0068, durationMs: 1300, status: "ok", error: null,
      activity: [],
      cliSessionId: "sess-g7h8i9", resumed: false, channel: "\u{1F527} dev-ops", agent: "DevBot",
      effort: null, thinking: false, resumeMethod: "newstart",
    },
    // --- random: CryptoChief ---
    {
      id: "req-rnd1", at: new Date(Date.now() - 350000).toISOString(), model: "claude-sonnet-4-20250514",
      tools: 1, promptLen: 700, inputTokens: 7800, cacheWriteTokens: 3500, cacheReadTokens: 62000,
      outputTokens: 2200, costUsd: 0.0092, durationMs: 1600, status: "ok", error: null,
      activity: ["Read fun-facts.md"],
      cliSessionId: "sess-j0k1l2", resumed: true, channel: "\u{1F4AC} random", agent: "CryptoChief",
      effort: "low", thinking: false, resumeMethod: "continuation",
    },
    // --- dm:Alice: Sentinel ---
    {
      id: "req-dm01", at: new Date(Date.now() - 500000).toISOString(), model: "claude-sonnet-4-20250514",
      tools: 2, promptLen: 1600, inputTokens: 15800, cacheWriteTokens: 8400, cacheReadTokens: 92000,
      outputTokens: 4500, costUsd: 0.0230, durationMs: 3400, status: "ok", error: null,
      activity: ["Read user-prefs.json", "Edit user-prefs.json"],
      cliSessionId: "sess-m3n4o5", resumed: true, channel: "dm:Alice", agent: "Sentinel",
      effort: "medium", thinking: true, resumeMethod: "tool_loop",
    },
  ],
}

export function useStatus() {
  const [data, setData] = useState<StatusData | null>(USE_MOCK ? MOCK_DATA : null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(() => new Date().toLocaleTimeString())

  const refresh = useCallback(async () => {
    setTick(new Date().toLocaleTimeString())
    if (USE_MOCK) return
    try {
      const res = await fetch("/status")
      const json = await res.json()
      setData(json)
      setError(null)
    } catch {
      setError("unreachable")
    }
  }, [])

  useEffect(() => {
    if (USE_MOCK) return
    refresh()
    const id = setInterval(refresh, POLL_INTERVAL)
    return () => clearInterval(id)
  }, [refresh])

  const cleanup = useCallback(async () => {
    if (USE_MOCK) return
    await fetch("/cleanup", {
      method: "POST",
      headers: { "X-OpenClaw-Bridge-CSRF": "cleanup" },
    })
    refresh()
  }, [refresh])

  return { data, error, tick, cleanup }
}
