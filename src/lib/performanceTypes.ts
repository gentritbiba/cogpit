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
}
