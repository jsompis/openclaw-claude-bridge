/** Deterministic session ID color from palette (matching original) */
const SID_PALETTE = [
  "#f87171", "#fb923c", "#fbbf24", "#a3e635", "#34d399", "#22d3ee",
  "#60a5fa", "#a78bfa", "#f472b6", "#e879f9", "#38bdf8", "#4ade80",
]
const sidMap: Record<string, string> = {}
let sidIdx = 0

export function sidColor(sid: string | null): string {
  if (!sid) return "#71717a"
  if (sidMap[sid]) return sidMap[sid]
  sidMap[sid] = SID_PALETTE[sidIdx % SID_PALETTE.length]
  sidIdx++
  return sidMap[sid]
}

/** Resume method → CSS color class (accepts raw or formatted values) */
export function resumeColorClass(rm: string): string {
  if (rm.includes("Tools") || rm === "tool_loop") return "text-blue-500"
  if (rm.includes("Chat") || rm === "continuation") return "text-emerald-500"
  if (rm.includes("Fallback") || rm === "fallback") return "text-amber-500"
  if (rm.includes("Refresh") || rm === "refresh") return "text-purple-400"
  if (rm.includes("Flush") || rm === "memflush") return "text-muted-foreground/70"
  if (rm.includes("New") || rm === "newstart") return "text-cyan-400"
  if (rm.includes("Initial")) return "text-muted-foreground"
  return "text-muted-foreground"
}

/** Think state → CSS color class */
export function thinkColorClass(thinking: boolean): string {
  return thinking ? "text-emerald-500" : "text-muted-foreground"
}

/** Status → CSS color class */
export function statusColorClass(status: string): string {
  switch (status) {
    case "ok": return "text-emerald-500"
    case "error": return "text-red-500"
    case "pending": return "text-amber-500"
    default: return "text-muted-foreground"
  }
}

/** Context usage % → CSS color class */
export function ctxColorClass(pct: number): string {
  if (pct > 65) return "text-red-500"
  if (pct > 40) return "text-amber-500"
  return "text-emerald-500"
}
