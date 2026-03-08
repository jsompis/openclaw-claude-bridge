import { useState } from "react"
import type { ActivityItem } from "@/lib/types"
import { fmtActivity } from "@/lib/format"

/** Relative time: "3s" / "2m" / "1h" */
function ago(ts: number): string {
  const diff = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (diff < 60) return `${diff}s`
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  return `${Math.floor(diff / 3600)}h`
}

/** Color class from formatted activity message */
function activityColor(msg: string): string {
  if (msg.startsWith("❌") || msg.startsWith("⚠️")) return "text-red-500"
  if (msg.startsWith("🔄")) return "text-blue-400"
  if (msg.startsWith("🔧")) return "text-amber-500"
  if (msg.startsWith("✅")) return "text-emerald-500"
  if (msg.startsWith("🧠")) return "text-purple-400"
  if (msg.startsWith("♻️")) return "text-cyan-400"
  if (msg.startsWith("🧹")) return "text-muted-foreground/70"
  return "text-muted-foreground/60"
}

const COMPACT_COUNT = 4

interface Props {
  items: ActivityItem[]
  hasRequests?: boolean
  reqToAgent?: Map<string, string>
  reqToChannel?: Map<string, string>
  isAllAgents?: boolean
}

export function ActivityFeed({ items, hasRequests, reqToAgent, reqToChannel, isAllAgents }: Props) {
  const [expanded, setExpanded] = useState(false)

  if (!items.length) {
    return (
      <div className="bg-card border border-border rounded-lg px-3.5 py-3">
        <span className="text-muted-foreground/60 text-xs italic">
          {hasRequests ? "No recent activity" : "Waiting for requests\u2026"}
        </span>
      </div>
    )
  }

  const visible = expanded ? items : items.slice(0, COMPACT_COUNT)
  const hasMore = items.length > COMPACT_COUNT

  return (
    <div className="bg-card border border-border rounded-lg px-3.5 py-2 max-h-[240px] overflow-y-auto scrollbar-thin">
      {visible.map((a, i) => {
        const display = fmtActivity(a.msg)
        const cls = activityColor(display)
        const agent = reqToAgent?.get(a.id)
        const channel = reqToChannel?.get(a.id)
        return (
          <div key={i} className="flex items-start gap-2 py-0.5 px-1 -mx-1 text-[0.78rem] leading-[1.7] rounded hover:bg-muted/20 transition-colors">
            <span className="text-muted-foreground/50 font-mono text-[0.65rem] shrink-0 w-7 text-right tabular-nums">
              {ago(a.at)}
            </span>
            {isAllAgents && agent && (
              <span className="shrink-0 text-[0.65rem] font-medium px-1.5 py-0 rounded bg-muted/40 text-muted-foreground">
                {agent}{channel ? ` · ${channel}` : ""}
              </span>
            )}
            {!isAllAgents && channel && (
              <span className="shrink-0 text-[0.65rem] font-medium px-1.5 py-0 rounded bg-muted/40 text-muted-foreground">
                {channel}
              </span>
            )}
            <span className={cls}>{display}</span>
          </div>
        )
      })}
      {hasMore && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[0.68rem] text-muted-foreground/50 hover:text-foreground mt-0.5 cursor-pointer"
        >
          {expanded ? "Show less" : `+${items.length - COMPACT_COUNT} more`}
        </button>
      )}
    </div>
  )
}
