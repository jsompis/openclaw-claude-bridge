export interface LogEntry {
  id: string
  at: string
  model: string | null
  tools: number
  promptLen: number
  inputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  outputTokens: number
  costUsd: number
  durationMs: number | null
  status: string
  error: string | null
  activity: string[]
  cliSessionId: string | null
  resumed: boolean
  channel: string | null
  agent: string | null
  effort: string | null
  thinking: boolean
  resumeMethod: string | null
  routingSource?: string | null
  contextWindow?: number | null
}

export interface ActivityItem {
  id: string
  at: number
  msg: string
}

export interface ChannelInfo {
  label: string
  sessionId: string
  age: number
  routingSource?: string | null
}

export interface StatusData {
  status: string
  uptime: number
  startedAt: string
  totalRequests: number
  activeRequests: number
  lastRequestAt: string | null
  lastModel: string | null
  errors: number
  sessions: { count: number; sizeKB: number }
  channels: ChannelInfo[]
  contextWindows?: Record<string, number>
  activity: ActivityItem[]
  log: LogEntry[]
}
