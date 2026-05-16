import { useState, useMemo } from "react"
import type { AgentGroup } from "@/lib/group"
import { hm, K, fmtModel, pct, fmtResume } from "@/lib/format"
import {
  sidColor,
  resumeColorClass,
  thinkColorClass,
  statusColorClass,
  ctxColorClass,
} from "@/lib/colors"

/** Strip Discord channel ID noise */
function cleanChannel(raw: string | null): string {
  if (!raw) return "unknown"
  return (
    raw
      .replace(/\s*channel\s*id:\S*/gi, "")
      .replace(/^#/, "")
      .trim() || raw
  )
}

interface AgentPanelProps {
  group: AgentGroup
  isAllAgents?: boolean
}

export function AgentPanel({ group, isAllAgents }: AgentPanelProps) {
  const [channelFilter, setChannelFilter] = useState<string | null>(null)
  const [resumeFilter, setResumeFilter] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 25

  const { channels, entries } = group

  // Channel filter only applies in All Agents view
  const channelEntries = isAllAgents && channelFilter
    ? entries.filter((e) => {
        const ch = e.channel ? e.channel.split("::")[0].slice(0, 30) : null
        return ch === channelFilter
      })
    : entries

  const resumeMethods = [
    ...new Set(channelEntries.map((e) => e.resumeMethod || "\u2014")),
  ]

  const visibleEntries = resumeFilter
    ? channelEntries.filter(
        (e) => (e.resumeMethod || "\u2014") === resumeFilter
      )
    : channelEntries

  // Per-session stats (ctx, cost, req count), ordered by recency
  const CTX_DEFAULT = 200_000
  const CTX_VISIBLE = 5
  const sessionCtx = useMemo(() => {
    // First pass: aggregate per-session stats
    const map = new Map<string, { sid: string; used: number; max: number; pct: number; agent: string; cost: number; reqs: number }>()
    const order: string[] = []
    for (const e of entries) {
      const sid = e.cliSessionId
      if (!sid) continue
      if (!map.has(sid)) {
        // First entry per session = latest (entries sorted newest-first)
        const used =
          (e.inputTokens || 0) +
          (e.cacheWriteTokens || 0) +
          (e.cacheReadTokens || 0)
        const ctxMax = e.contextWindow || CTX_DEFAULT
        map.set(sid, {
          sid,
          used,
          max: ctxMax,
          pct: Math.round((used / ctxMax) * 100),
          agent: e.agent || "unknown",
          cost: e.costUsd || 0,
          reqs: 1,
        })
        order.push(sid)
      } else {
        const s = map.get(sid)!
        s.cost += e.costUsd || 0
        s.reqs++
      }
    }
    return order.map((sid) => map.get(sid)!).filter((s) => s.used > 0)
  }, [entries])

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden flex flex-col flex-1 min-h-0">
      {/* Filters */}
      {(isAllAgents && channels.length > 1 || resumeMethods.length > 1) && (
        <div className="flex items-center px-2.5 md:px-3.5 py-1.5 md:py-2 border-b border-border/50 shrink-0 gap-1 flex-wrap">
          {/* Channel filter — All Agents only */}
          {isAllAgents && channels.length > 1 && (
            <>
              <span className="text-[0.68rem] text-muted-foreground/50 mr-1">Agent</span>
              <FilterBadge
                label="All"
                active={channelFilter === null}
                onClick={() => {
                  setChannelFilter(null)
                  setResumeFilter(null)
                  setPage(0)
                }}
              />
              {channels.map((ch) => (
                <FilterBadge
                  key={ch}
                  label={cleanChannel(ch)}
                  active={channelFilter === ch}
                  onClick={() => {
                    setChannelFilter(channelFilter === ch ? null : ch)
                    setResumeFilter(null)
                    setPage(0)
                  }}
                />
              ))}
              {resumeMethods.length > 1 && (
                <span className="w-px h-4 bg-border mx-1.5" />
              )}
            </>
          )}
          {/* Resume method filter */}
          {resumeMethods.length > 1 && (
            <>
              <span className="text-[0.68rem] text-muted-foreground/50 mr-1">Resume</span>
              <FilterBadge
                label="All"
                active={resumeFilter === null}
                onClick={() => { setResumeFilter(null); setPage(0) }}
              />
              {resumeMethods.map((rm) => (
                <FilterBadge
                  key={rm}
                  label={fmtResume(rm === "\u2014" ? null : rm)}
                  active={resumeFilter === rm}
                  onClick={() => {
                    setResumeFilter(resumeFilter === rm ? null : rm)
                    setPage(0)
                  }}
                  colorClass={resumeColorClass(rm)}
                />
              ))}
            </>
          )}
        </div>
      )}

      {/* Per-session context cards */}
      {sessionCtx.length > 0 && (
        <div className="border-b border-border/30 shrink-0 px-3 py-2 max-h-[120px] overflow-y-auto scrollbar-thin bg-muted/10">
          <div className="flex gap-2 flex-wrap">
            {sessionCtx.slice(0, CTX_VISIBLE).map((s) => (
              <CtxCard key={s.sid} {...s} max={s.max} />
            ))}
            {sessionCtx.length > CTX_VISIBLE && (
              <div className="flex items-center px-2 text-[0.7rem] text-muted-foreground/50">
                +{sessionCtx.length - CTX_VISIBLE} older
              </div>
            )}
          </div>
        </div>
      )}

      {/* Table — 13 columns */}
      <div className="overflow-auto flex-1 scrollbar-thin">
        <table className="w-full border-collapse text-[0.75rem] md:text-[0.8rem] min-w-[900px]">
          <thead>
            <tr className="text-left text-muted-foreground/60 text-[0.68rem] uppercase tracking-wide border-b border-border">
              <th className="py-1.5 px-2.5 font-medium sticky top-0 bg-card z-10">Time</th>
              <th className="py-1.5 px-2.5 font-medium sticky top-0 bg-card z-10">Channel</th>
              <th className="py-1.5 px-2.5 font-medium sticky top-0 bg-card z-10">Session</th>
              <th className="py-1.5 px-2.5 font-medium sticky top-0 bg-card z-10">Resume</th>
              <th className="py-1.5 px-2.5 font-medium sticky top-0 bg-card z-10">Route</th>
              <th className="py-1.5 px-2.5 font-medium sticky top-0 bg-card z-10 text-right">Prompt</th>
              <th className="py-1.5 px-2.5 font-medium sticky top-0 bg-card z-10">Model</th>
              <th className="py-1.5 px-2.5 font-medium sticky top-0 bg-card z-10">Think</th>
              <th className="py-1.5 px-2.5 font-medium sticky top-0 bg-card z-10 text-right">In</th>
              <th className="py-1.5 px-2.5 font-medium sticky top-0 bg-card z-10 text-right">Out</th>
              <th className="py-1.5 px-2.5 font-medium sticky top-0 bg-card z-10 text-right">Cost</th>
              <th className="py-1.5 px-2.5 font-medium sticky top-0 bg-card z-10 text-right">Cache</th>
              <th className="py-1.5 px-2.5 font-medium sticky top-0 bg-card z-10 text-right">Duration</th>
              <th className="py-1.5 px-2.5 font-medium sticky top-0 bg-card z-10">Status</th>
            </tr>
          </thead>
          <tbody>
            {visibleEntries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((e) => {
              const totalIn =
                (e.inputTokens || 0) +
                (e.cacheWriteTokens || 0) +
                (e.cacheReadTokens || 0)
              const cacheRate = pct(e.cacheReadTokens || 0, totalIn)
              const dur =
                e.durationMs != null
                  ? `${(e.durationMs / 1000).toFixed(1)}s`
                  : "\u2026"
              const rm = fmtResume(e.resumeMethod)
              const thk = e.thinking ? e.effort || "on" : "off"

              return (
                <RequestRow
                  key={e.id}
                  time={hm(e.at)}
                  channel={cleanChannel(e.channel)}
                  sessionId={e.cliSessionId}
                  resumed={e.resumed}
                  resume={rm}
                  route={e.routingSource || "—"}
                  prompt={K(e.promptLen || 0)}
                  model={fmtModel(e.model)}
                  think={thk}
                  thinking={e.thinking}
                  inTokens={K(totalIn)}
                  outTokens={K(e.outputTokens)}
                  cost={e.costUsd ? `$${e.costUsd.toFixed(4)}` : "\u2014"}
                  cache={cacheRate}
                  duration={dur}
                  status={e.status}
                  activity={e.activity}
                  error={e.error}
                />
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {visibleEntries.length > PAGE_SIZE && (
        <div className="flex items-center justify-between px-2.5 md:px-3.5 py-1.5 md:py-2 border-t border-border/50 shrink-0 text-[0.7rem] md:text-[0.75rem]">
          <span className="text-muted-foreground/60 font-mono tabular-nums">
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, visibleEntries.length)} of {visibleEntries.length}
          </span>
          <div className="flex items-center gap-1">
            <PaginationBtn
              label="← Prev"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            />
            {(() => {
              const total = Math.ceil(visibleEntries.length / PAGE_SIZE)
              const pages: (number | "...")[] = []
              for (let i = 0; i < total; i++) {
                if (i === 0 || i === total - 1 || Math.abs(i - page) <= 1) {
                  pages.push(i)
                } else if (pages[pages.length - 1] !== "...") {
                  pages.push("...")
                }
              }
              return pages.map((p, idx) =>
                p === "..." ? (
                  <span key={`e${idx}`} className="px-1 text-muted-foreground/40">…</span>
                ) : (
                  <span
                    key={p}
                    onClick={() => setPage(p)}
                    className={`px-2 py-0.5 rounded cursor-pointer transition-colors font-mono tabular-nums ${
                      p === page
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground/60 hover:text-foreground hover:bg-muted/30"
                    }`}
                  >
                    {p + 1}
                  </span>
                )
              )
            })()}
            <PaginationBtn
              label="Next →"
              disabled={(page + 1) * PAGE_SIZE >= visibleEntries.length}
              onClick={() => setPage(page + 1)}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function RequestRow({
  time, channel, sessionId, resumed, resume, route, prompt, model,
  think, thinking, inTokens, outTokens, cost, cache, duration,
  status, activity, error,
}: {
  time: string; channel: string; sessionId: string | null; resumed: boolean
  resume: string; route: string; prompt: string; model: string; think: string
  thinking: boolean; inTokens: string; outTokens: string; cost: string
  cache: string; duration: string; status: string; activity: string[]
  error: string | null
}) {
  const [expanded, setExpanded] = useState(false)
  const mono = "font-mono tabular-nums"
  const r = "text-right"
  return (
    <>
      <tr className="border-b border-border/20 hover:bg-muted/30 transition-colors">
        <td className={`py-1.5 px-2.5 whitespace-nowrap text-muted-foreground/70 ${mono}`}>
          <span
            className={`inline-block w-3 mr-1 ${activity.length > 0 ? "cursor-pointer text-muted-foreground/50 hover:text-foreground" : ""}`}
            onClick={activity.length > 0 ? () => setExpanded(!expanded) : undefined}
          >
            {activity.length > 0 ? (expanded ? "\u25be" : "\u25b8") : ""}
          </span>
          {time}
        </td>
        <td className="py-1.5 px-2.5 whitespace-nowrap text-muted-foreground truncate max-w-[130px]">{channel}</td>
        <td className={`py-1.5 px-2.5 whitespace-nowrap ${mono}`} style={{ color: sidColor(sessionId) }}>
          {resumed ? "\u21a9 " : "\u2295 "}{sessionId || "\u2014"}
        </td>
        <td className={`py-1.5 px-2.5 whitespace-nowrap ${resumeColorClass(resume)}`}>{resume}</td>
        <td className="py-1.5 px-2.5 whitespace-nowrap text-muted-foreground">{route}</td>
        <td className={`py-1.5 px-2.5 whitespace-nowrap text-muted-foreground ${mono} ${r}`}>{prompt}</td>
        <td className="py-1.5 px-2.5 whitespace-nowrap text-muted-foreground">{model}</td>
        <td className={`py-1.5 px-2.5 whitespace-nowrap ${thinkColorClass(thinking)}`}>{think}</td>
        <td className={`py-1.5 px-2.5 whitespace-nowrap text-muted-foreground ${mono} ${r}`}>{inTokens}</td>
        <td className={`py-1.5 px-2.5 whitespace-nowrap text-muted-foreground ${mono} ${r}`}>{outTokens}</td>
        <td className={`py-1.5 px-2.5 whitespace-nowrap text-muted-foreground ${mono} ${r}`}>{cost}</td>
        <td className={`py-1.5 px-2.5 whitespace-nowrap text-muted-foreground ${mono} ${r}`}>{cache}</td>
        <td className={`py-1.5 px-2.5 whitespace-nowrap text-muted-foreground ${mono} ${r}`}>{duration}</td>
        <td className={`py-1.5 px-2.5 whitespace-nowrap ${statusColorClass(status)}`}>{status}</td>
      </tr>
      {expanded && activity.length > 0 && (
        <tr>
          <td colSpan={14} className="px-2.5 py-1 pl-9 text-[0.68rem] text-muted-foreground/60 leading-[1.7] border-b border-border">
            {activity.map((a, i) => <div key={i}>{a}</div>)}
          </td>
        </tr>
      )}
      {error && (
        <tr>
          <td colSpan={14} className="px-2.5 py-0.5 pl-9 text-[0.68rem] text-red-500 border-b border-border">
            {error}
          </td>
        </tr>
      )}
    </>
  )
}

function CtxCard({ sid, agent, used, pct, max, cost, reqs }: {
  sid: string; agent: string; used: number; pct: number; max: number
  cost: number; reqs: number
}) {
  const barBg = pct > 65 ? "bg-red-500" : pct > 40 ? "bg-amber-500" : "bg-emerald-500"
  return (
    <div className="border border-border/50 rounded-md px-2 md:px-2.5 py-1.5 min-w-[140px] md:min-w-[160px] hover:border-border hover:bg-muted/15 transition-colors">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[0.75rem] font-mono truncate" style={{ color: sidColor(sid) }}>
          {sid.slice(0, 7)}
        </span>
        <span className="text-[0.68rem] text-muted-foreground/60 ml-1.5 truncate">{agent}</span>
      </div>
      <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden mb-1">
        <div
          className={`h-full rounded-full ${barBg}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[0.7rem] font-mono tabular-nums">
        <span className={ctxColorClass(pct)}>{pct}%</span>
        <span className="text-muted-foreground/60">{K(used)} / {K(max)}</span>
      </div>
      <div className="flex items-center justify-between mt-1 text-[0.68rem] font-mono tabular-nums text-muted-foreground/60">
        <span>{reqs} req</span>
        <span className="text-amber-500/80">${cost.toFixed(4)}</span>
      </div>
    </div>
  )
}

function FilterBadge({
  label, active, onClick, colorClass,
}: {
  label: string; active: boolean; onClick?: () => void; colorClass?: string
}) {
  return (
    <span
      className={`ml-1 text-[0.75rem] px-2 py-0.5 rounded border transition-all ${
        active
          ? colorClass
            ? `border-current ${colorClass}`
            : "bg-blue-500 border-blue-500 text-white"
          : "border-muted-foreground/40 text-muted-foreground hover:border-muted-foreground/70 hover:text-foreground/90 hover:bg-muted/20"
      } ${onClick ? "cursor-pointer" : ""}`}
      onClick={onClick}
    >
      {label}
    </span>
  )
}

function PaginationBtn({ label, disabled, onClick }: {
  label: string; disabled: boolean; onClick: () => void
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`px-2.5 py-0.5 rounded text-[0.75rem] transition-colors ${
        disabled
          ? "text-muted-foreground/30 cursor-not-allowed"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/30 cursor-pointer"
      }`}
    >
      {label}
    </button>
  )
}
