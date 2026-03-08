/** Uptime seconds → "Xh Ym" or "Ym Xs" */
export function fmtUptime(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sc = s % 60
  return h ? `${h}h ${m}m` : m ? `${m}m ${sc}s` : `${sc}s`
}

/** Token count → "1.2M" / "1.2K" / raw number / "—" */
export function K(n: number | null | undefined): string {
  if (n == null) return "\u2014"
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M"
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K"
  return String(n)
}

/** KB → "X.X MB" or "X KB" */
export function fmtSize(kb: number): string {
  return kb >= 1024 ? (kb / 1024).toFixed(1) + " MB" : kb + " KB"
}

/** Strip "claude-" and "-latest" from model name */
export function fmtModel(s: string | null): string {
  return (s || "\u2014").replace("claude-", "").replace("-latest", "")
}

/** Percentage with fallback */
export function pct(a: number, b: number): string {
  if (!b) return "\u2014"
  return Math.round((a / b) * 100) + "%"
}

/** Resume method → friendly display name */
export function fmtResume(rm: string | null): string {
  switch (rm) {
    case "tool_loop": return "🔧 Tools"
    case "continuation": return "💬 Chat"
    case "newstart": return "🆕 New"
    case "memflush": return "🧹 Flush"
    case "refresh": return "♻️ Refresh"
    case "fallback": return "⚠️ Fallback"
    default: return "▶️ Initial"
  }
}

/** Raw activity message → friendly display text */
export function fmtActivity(msg: string): string {
  // tool_calls: [bash, read, ...] → 🔧 Tools: bash, read, ...
  const toolMatch = msg.match(/tool_calls:\s*\[([^\]]*)\]/)
  if (toolMatch) return `🔧 Tools: ${toolMatch[1]}`

  // memflush intercepted (12K chars) → 🧹 Memory flush (12K)
  const memMatch = msg.match(/memflush intercepted\s*\(([^)]*)\s*chars\)/)
  if (memMatch) return `🧹 Memory flush (${memMatch[1]})`

  // context refresh → new session (1234 chars) → ♻️ Context refresh
  if (msg.includes("context refresh")) return "♻️ Context refresh"

  // resuming session (1234 chars new) → 🔄 Resuming (1.2K chars)
  const resMatch = msg.match(/resuming session\s*\((\d+)\s*chars/)
  if (resMatch) {
    const n = Number(resMatch[1])
    const sz = n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n)
    return `🔄 Resuming (${sz} chars)`
  }

  // thinking... (5 tools) [resume fallback] → 🧠 Thinking (5 tools, fallback)
  if (msg.includes("thinking") && msg.includes("resume fallback")) {
    const tMatch = msg.match(/\((\d+)\s*tools\)/)
    return `🧠 Thinking (${tMatch ? tMatch[1] + " tools, " : ""}fallback)`
  }

  // thinking... (5 tools) → 🧠 Thinking (5 tools)
  const thinkMatch = msg.match(/thinking.*\((\d+)\s*tools\)/)
  if (thinkMatch) return `🧠 Thinking (${thinkMatch[1]} tools)`

  // done 3.2s → ✅ Done (3.2s)
  const doneMatch = msg.match(/done\s+([\d.]+s)/)
  if (doneMatch) return `✅ Done (${doneMatch[1]})`

  // CLI failed → ⚠️ Retry (CLI error)
  if (msg.includes("CLI failed")) return "⚠️ Retry (CLI error)"

  // Anything else with error/fail
  if (msg.includes("error") || msg.includes("Error") || msg.includes("fail"))
    return `❌ ${msg}`

  return msg
}

/** ISO date → locale time string */
export function hm(iso: string | null): string {
  if (!iso) return ""
  return new Date(iso).toLocaleTimeString()
}
