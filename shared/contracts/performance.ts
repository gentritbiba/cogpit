export interface ElectronProcessMetric {
  pid: number
  name: string
  type: string
  cpuPercent: number
  memoryMb: number
  idleWakeupsPerSecond?: number
}

export interface ElectronPerformanceSnapshot {
  capturedAt: number
  processes: ElectronProcessMetric[]
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

export type SystemProcessKind =
  | "claude"
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
