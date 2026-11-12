/** A desktop app process, as the shell reports it. */
export interface DesktopProcessMetric {
  pid: number
  name: string
  type: string
  cpuPercent: number
  memoryMb: number
  idleWakeupsPerSecond?: number
}

export interface DesktopPerformanceSnapshot {
  capturedAt: number
  processes: DesktopProcessMetric[]
}

export interface ActivityMetric {
  name: string
  count: number
  totalCount: number
  ratePerSecond: number
  bytesPerSecond: number
  averageDurationMs?: number
  active?: number
}

import type { AgentKind } from "../session/agent-descriptors"

export type SystemProcessKind = AgentKind
  /** One kind per agent CLI, matching `AgentKind`. */
  | "claude"
  | "codex"
  | "copilot"
  | "headless-browser"
  | "browser-daemon"
  | "cogpit"
  | "script"
  | "other"

export interface SystemProcessMetric {
  pid: number
  kind: SystemProcessKind
  label: string
  command: string
  cpuPercent: number
  memoryMb: number
  ageSeconds: number
  orphaned: boolean
  suspectedLeak: boolean
  identity?: string
  canStop?: boolean
  warning?: "sustained-cpu"
  owner?: {
    sessionId: string
    taskId: string
    title?: string
    dirName?: string
    fileName?: string
  }
}

export interface SystemProcessTarget {
  pid: number
  identity: string
}

export interface SystemProcessesSnapshot {
  capturedAt: number
  processes: SystemProcessMetric[]
  suspectedLeakCount: number
}

export interface ReapedEvent {
  at: number
  rootPid: number
  command: string
  killedPids: number[]
}

export interface SystemProcessesResponse extends SystemProcessesSnapshot {
  recentlyReaped: ReapedEvent[]
}

export interface ServerPerformanceSnapshot {
  capturedAt: number
  sampleWindowSeconds: number
  cpuPercent: number
  eventLoopPercent: number
  uptimeSeconds: number
  memory: {
    rssMb: number
    heapUsedMb: number
  }
  activities: ActivityMetric[]
  requests: ActivityMetric[]
  system?: SystemProcessesSnapshot
}
