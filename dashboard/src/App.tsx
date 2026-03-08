import { useState, useEffect, useCallback, useMemo } from "react"
import { useStatus } from "@/hooks/use-status"
import { groupByAgent } from "@/lib/group"
import type { AgentGroup } from "@/lib/group"
import { fmtUptime, fmtSize } from "@/lib/format"
import { Sidebar } from "@/components/Sidebar"
import { AgentPanel } from "@/components/AgentPanel"
import { ActivityFeed } from "@/components/ActivityFeed"

function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    return (localStorage.getItem("theme") as "dark" | "light") || "dark"
  })

  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light")
    localStorage.setItem("theme", theme)
  }, [theme])

  const toggle = useCallback(
    () => setTheme((t) => (t === "dark" ? "light" : "dark")),
    []
  )

  return { theme, toggle }
}

export default function App() {
  const { data, error, tick, cleanup } = useStatus()
  const { theme, toggle: toggleTheme } = useTheme()
  const [activeAgent, setActiveAgent] = useState<string | null>(null)

  const log = data?.log || []
  const agentGroups = useMemo(() => groupByAgent(log), [log])

  // If selected agent vanishes from data, fall back to All
  useEffect(() => {
    if (
      activeAgent !== null &&
      agentGroups.length &&
      !agentGroups.find((g) => g.agent === activeAgent)
    ) {
      setActiveAgent(null)
    }
  }, [agentGroups, activeAgent])

  // Request ID → agent / channel lookup
  const reqToAgent = useMemo(() => {
    const map = new Map<string, string>()
    for (const e of log) {
      if (e.agent) map.set(e.id, e.agent)
    }
    return map
  }, [log])

  const reqToChannel = useMemo(() => {
    const map = new Map<string, string>()
    for (const e of log) {
      if (e.channel) {
        const short = e.channel
          .split("::")[0]
          .replace(/\s*channel\s*id:\S*/gi, "")
          .replace(/^#/, "")
          .trim()
        if (short) map.set(e.id, short)
      }
    }
    return map
  }, [log])

  // Combined "All" group
  const totalCost = useMemo(
    () => log.reduce((s, e) => s + (e.costUsd || 0), 0),
    [log]
  )

  const allGroup: AgentGroup = useMemo(
    () => ({
      agent: "All Agents",
      channels: [...new Set(agentGroups.flatMap((g) => g.channels))],
      sessions: [...new Set(agentGroups.flatMap((g) => g.sessions))],
      entries: log
        .slice()
        .sort(
          (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()
        ),
      totalCost,
    }),
    [agentGroups, log, totalCost]
  )

  // --- all hooks above, early returns below ---

  if (!data && !error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex items-center gap-2.5 text-muted-foreground text-xs">
          <span className="w-[7px] h-[7px] rounded-full bg-emerald-500 animate-pulse-glow" />
          Connecting...
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-red-500 text-xs">Bridge unreachable</div>
      </div>
    )
  }

  const latestWithTools = data.log.find((e) => e.tools > 0)

  const filteredActivity =
    activeAgent === null
      ? (data.activity || [])
      : (data.activity || []).filter(
          (a) => reqToAgent.get(a.id) === activeAgent
        )

  const activeGroup =
    activeAgent === null
      ? allGroup
      : agentGroups.find((g) => g.agent === activeAgent) || allGroup

  return (
    <div className="h-screen p-1.5 sm:p-3 md:p-4">
      {/* App frame — contained, bordered, max-width */}
      <div className="h-full max-w-[1500px] mx-auto border border-border rounded-xl overflow-hidden flex flex-col bg-background shadow-sm animate-fade-in-up">
        {/* Header */}
        <header className="flex items-center justify-between px-3 md:px-5 py-2 md:py-2.5 border-b border-border bg-card shrink-0 gap-2 flex-wrap">
          <h1 className="text-sm md:text-base font-semibold flex items-center gap-2">
            <span className="w-[7px] h-[7px] rounded-full bg-emerald-500 animate-pulse-glow" />
            <span className="hidden sm:inline">OpenClaw Claude Bridge</span>
            <span className="sm:hidden">OCB</span>
          </h1>
          <div className="flex items-center text-xs font-mono tabular-nums gap-x-1">
            {/* Status — always visible */}
            <span className="text-emerald-500">● {data.status === "running" ? "Online" : "Offline"}</span>

            {/* Cost — always visible */}
            <Sep className="hidden md:inline-block" />
            <span className="hidden md:inline text-muted-foreground">⏱ {fmtUptime(data.uptime)}</span>
            <Sep className="hidden md:inline-block" />
            <span className="hidden md:inline text-muted-foreground">📨 {data.totalRequests} req</span>
            <Dot className="hidden md:inline" />
            <span className="hidden md:inline text-blue-500">⚡ {data.activeRequests} active</span>

            <Sep />
            <span className="text-amber-500 font-semibold">💰 ${totalCost.toFixed(2)}</span>

            {/* Desktop-only stats */}
            <Sep className="hidden md:inline-block" />
            <span className="hidden md:inline text-muted-foreground">📂 {data.sessions.count} sess</span>
            <Dot className="hidden md:inline" />
            <span className="hidden md:inline text-muted-foreground">{fmtSize(data.sessions.sizeKB)}</span>

            <Sep className="hidden md:inline-block" />
            <span className={`hidden md:inline ${data.errors > 0 ? "text-red-500" : "text-emerald-500"}`}>
              {data.errors > 0 ? "⚠" : "✓"} {data.errors} err
            </span>
            <Dot className="hidden md:inline" />
            <span className="hidden md:inline text-muted-foreground">
              🔧 {latestWithTools ? `${latestWithTools.tools} tools` : "\u2014"}
            </span>

            <Sep className="hidden md:inline-block" />
            <span className="hidden md:inline text-muted-foreground/60 text-[0.68rem]">↻ {tick}</span>
            <button
              onClick={toggleTheme}
              className="ml-1 md:ml-1.5 text-[0.7rem] px-1.5 md:px-2 py-0.5 rounded border border-border text-muted-foreground/70 hover:text-foreground hover:border-muted-foreground transition-all cursor-pointer font-sans"
            >
              {theme === "dark" ? "☀️" : "🌙"}<span className="hidden md:inline"> {theme === "dark" ? "Light" : "Dark"}</span>
            </button>
          </div>
        </header>

        {/* Body: Sidebar + Content */}
        <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
          {/* Sidebar */}
          <Sidebar
            agents={agentGroups}
            activeAgent={activeAgent}
            onSelect={setActiveAgent}
          />

          {/* Content */}
          <main className="flex-1 flex flex-col overflow-hidden px-2.5 md:px-4 py-2 md:py-3 gap-2 md:gap-3">
            {/* Live Activity */}
            <div className="shrink-0">
              <SectionLabel>Live Activity</SectionLabel>
              <ActivityFeed items={filteredActivity} hasRequests={activeGroup.entries.length > 0} reqToAgent={reqToAgent} reqToChannel={reqToChannel} isAllAgents={activeAgent === null} />
            </div>

            {/* Agent Panel */}
            <div className="flex flex-col flex-1 min-h-0">
              <SectionLabel right={
                <button
                  onClick={cleanup}
                  className="text-[0.68rem] px-2 py-0.5 rounded border border-border text-muted-foreground/60 hover:text-foreground hover:border-muted-foreground transition-all cursor-pointer font-sans normal-case tracking-normal"
                >
                  🧹 Clean Sessions
                </button>
              }>
                Sessions
                <span className="text-foreground/60 normal-case tracking-normal ml-1.5 text-[0.85rem]">
                  / {activeAgent || "All Agents"}
                </span>
              </SectionLabel>
              {activeGroup ? (
                <AgentPanel group={activeGroup} isAllAgents={activeAgent === null} />
              ) : (
                <div className="bg-card border border-border rounded-lg px-3.5 py-5">
                  <span className="text-muted-foreground/60 text-xs italic">
                    No requests yet
                  </span>
                </div>
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}

/** Thin vertical separator for header metric groups */
function Sep({ className }: { className?: string }) {
  return <span className={`w-px h-3.5 bg-border mx-1.5 md:mx-3 ${className || ""}`} />
}

/** Small dot separator within a group */
function Dot({ className }: { className?: string }) {
  return <span className={`text-muted-foreground/35 mx-1 md:mx-1.5 ${className || ""}`}>&middot;</span>
}

function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="text-[0.7rem] text-muted-foreground/60 uppercase tracking-widest mb-2 flex items-center gap-1.5">
      <span className="w-[5px] h-[5px] rounded-full bg-muted-foreground/50" />
      {children}
      {right && <span className="ml-auto">{right}</span>}
    </div>
  )
}
