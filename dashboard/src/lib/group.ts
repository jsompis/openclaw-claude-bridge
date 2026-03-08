import type { LogEntry } from "./types"

export interface AgentGroup {
  agent: string
  channels: string[]
  sessions: string[]
  entries: LogEntry[]
  totalCost: number
}

/**
 * Group log entries by agent. Each agent becomes a sidebar item.
 * Channels become sub-filters within the agent's content panel.
 */
export function groupByAgent(log: LogEntry[]): AgentGroup[] {
  const groups: Record<string, AgentGroup> = {}
  const order: string[] = []

  for (const e of log) {
    const agent = e.agent || "unknown"

    if (!groups[agent]) {
      groups[agent] = { agent, channels: [], sessions: [], entries: [], totalCost: 0 }
      order.push(agent)
    }

    const g = groups[agent]
    g.entries.push(e)

    const ch = e.channel ? e.channel.split("::")[0].slice(0, 30) : null
    if (ch && !g.channels.includes(ch)) g.channels.push(ch)
    if (e.cliSessionId && !g.sessions.includes(e.cliSessionId))
      g.sessions.push(e.cliSessionId)
    g.totalCost += e.costUsd || 0
  }

  for (const g of Object.values(groups)) {
    g.entries.sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()
    )
  }

  // Most recent activity first
  order.sort((a, b) => {
    const aTime = new Date(groups[a].entries[0]?.at || 0).getTime()
    const bTime = new Date(groups[b].entries[0]?.at || 0).getTime()
    return bTime - aTime
  })

  return order.map((k) => groups[k])
}
