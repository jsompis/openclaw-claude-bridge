import type { AgentGroup } from "@/lib/group"
import { hm } from "@/lib/format"

/** Agent dot color based on recency: green if active in last 5min, amber if 30min, gray otherwise */
function activityDotClass(latestAt: string | undefined): string {
  if (!latestAt) return "bg-muted-foreground/30"
  const ago = Date.now() - new Date(latestAt).getTime()
  if (ago < 5 * 60_000) return "bg-emerald-500 animate-pulse-glow"
  if (ago < 30 * 60_000) return "bg-amber-500"
  return "bg-muted-foreground/30"
}

interface SidebarProps {
  agents: AgentGroup[]
  activeAgent: string | null
  onSelect: (agent: string | null) => void
}

export function Sidebar({
  agents,
  activeAgent,
  onSelect,
}: SidebarProps) {
  const totalReqs = agents.reduce((s, g) => s + g.entries.length, 0)

  return (
    <aside className="bg-sidebar border-b md:border-b-0 md:border-r border-border shrink-0 overflow-hidden md:w-[240px] md:flex md:flex-col">
      {/* ── Mobile: horizontal pill bar ── */}
      <div className="flex md:hidden items-center gap-1.5 px-2.5 py-2 overflow-x-auto scrollbar-thin">
        <span className="text-[0.6rem] text-muted-foreground/50 uppercase tracking-widest shrink-0 mr-1">Agents</span>
        <MobilePill
          label={`All (${totalReqs})`}
          active={activeAgent === null}
          onClick={() => onSelect(null)}
        />
        {agents.map((g) => (
          <MobilePill
            key={g.agent}
            label={g.agent}
            active={g.agent === activeAgent}
            onClick={() => onSelect(g.agent)}
            dot={activityDotClass(g.entries[0]?.at)}
            cost={g.totalCost}
          />
        ))}
      </div>

      {/* ── Desktop: vertical sidebar ── */}
      <div className="hidden md:flex md:flex-col md:flex-1 md:overflow-y-auto scrollbar-thin">
        <div className="px-3 py-2.5 text-[0.63rem] text-muted-foreground/60 uppercase tracking-widest">
          Agents
        </div>
        {/* All Agents option */}
        <button
          onClick={() => onSelect(null)}
          className={`
            w-full text-left px-3 py-2.5 transition-colors cursor-pointer
            border-l-2 border-b border-border/30
            ${activeAgent === null
              ? "bg-background border-l-emerald-500"
              : "border-l-transparent hover:bg-muted/50"
            }
          `}
        >
          <div className="flex items-center gap-2">
            <span className="w-[6px] h-[6px] rounded-full shrink-0 bg-muted-foreground/50" />
            <span
              className={`text-[0.85rem] ${
                activeAgent === null
                  ? "font-semibold text-foreground"
                  : "text-muted-foreground"
              }`}
            >
              All Agents
            </span>
            <span className="ml-auto text-[0.65rem] text-muted-foreground/50 font-mono tabular-nums">
              {totalReqs} req
            </span>
          </div>
        </button>
        {agents.map((g) => {
          const isActive = g.agent === activeAgent
          const lastAt = g.entries[0]?.at ? hm(g.entries[0].at) : ""
          return (
            <button
              key={g.agent}
              onClick={() => onSelect(g.agent)}
              className={`
                w-full text-left px-3 py-2.5 transition-colors cursor-pointer
                border-l-2 border-b border-border/30
                ${isActive
                  ? "bg-background border-l-emerald-500"
                  : "border-l-transparent hover:bg-muted/50"
                }
              `}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`w-[6px] h-[6px] rounded-full shrink-0 ${activityDotClass(g.entries[0]?.at)}`}
                />
                <span
                  className={`text-[0.85rem] truncate ${
                    isActive
                      ? "font-semibold text-foreground"
                      : "text-muted-foreground"
                  }`}
                >
                  {g.agent}
                </span>
                <span className="ml-auto text-[0.65rem] text-muted-foreground/50 font-mono tabular-nums">
                  {lastAt}
                </span>
              </div>
              <div className="flex gap-2.5 mt-1 pl-[14px] text-[0.65rem] text-muted-foreground/60 font-mono tabular-nums">
                <span>{g.sessions.length} sess</span>
                <span>{g.entries.length} req</span>
                <span className="text-amber-500/70">
                  ${g.totalCost.toFixed(2)}
                </span>
              </div>
            </button>
          )
        })}
        {agents.length === 0 && (
          <div className="px-3 py-5 text-[0.7rem] text-muted-foreground/50 italic">
            No agents active
          </div>
        )}
      </div>
    </aside>
  )
}

function MobilePill({ label, active, onClick, dot, cost }: {
  label: string; active: boolean; onClick: () => void
  dot?: string; cost?: number
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[0.72rem] transition-colors cursor-pointer whitespace-nowrap border ${
        active
          ? "bg-background border-emerald-500/60 text-foreground font-medium"
          : "border-border text-muted-foreground hover:bg-muted/40"
      }`}
    >
      {dot && <span className={`w-[5px] h-[5px] rounded-full shrink-0 ${dot}`} />}
      {label}
      {cost != null && cost > 0 && (
        <span className="text-amber-500/70 text-[0.62rem] font-mono">${cost.toFixed(2)}</span>
      )}
    </button>
  )
}
