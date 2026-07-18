import { useEffect, useEffectEvent, useRef, useState } from "react"
import { Activity, Check, Copy, RefreshCw } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { HeaderIconButton } from "@/components/header-shared"
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback"
import { authFetch } from "@/lib/auth"
import { formatAge } from "@/lib/format"
import { cn } from "@/lib/utils"
import type {
  ActivityMetric,
  ElectronPerformanceSnapshot,
  ElectronProcessMetric,
  ServerPerformanceSnapshot,
  SystemProcessMetric,
} from "@/lib/performanceTypes"

const POLL_INTERVAL_MS = 2_000
const MAX_HISTORY_SAMPLES = 30

function formatCpu(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)}%`
}

function formatMemory(value: number): string {
  return `${value.toFixed(0)} MB`
}

function formatRate(value: number): string {
  if (value >= 10) return `${value.toFixed(0)}/s`
  if (value >= 1) return `${value.toFixed(1)}/s`
  return `${value.toFixed(2)}/s`
}

function formatBytesPerSecond(value: number): string | null {
  if (value <= 0) return null
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB/s`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB/s`
  return `${value.toFixed(0)} B/s`
}

function SystemProcessRow({ metric, onKill }: { metric: SystemProcessMetric; onKill?: (pid: number) => void }) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{metric.label}</span>
          <Badge variant="outline">PID {metric.pid}</Badge>
          {metric.suspectedLeak && <Badge variant="destructive">possible leak</Badge>}
          {metric.orphaned && !metric.suspectedLeak && <Badge variant="secondary">orphaned</Badge>}
        </div>
        <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={metric.command}>
          {metric.command}
        </p>
      </div>
      {metric.suspectedLeak && onKill && (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 text-destructive hover:bg-destructive/10"
          onClick={() => onKill(metric.pid)}
        >
          Kill
        </Button>
      )}
      <div className="shrink-0 text-right">
        <div className={cn(
          "font-mono text-sm font-semibold tabular-nums",
          metric.cpuPercent >= 20 && "text-destructive",
        )}>
          {formatCpu(metric.cpuPercent)}
        </div>
        <div className="text-xs text-muted-foreground">
          {formatMemory(metric.memoryMb)} · {formatAge(metric.ageSeconds)}
        </div>
      </div>
    </div>
  )
}

function processHint(metric: ElectronProcessMetric): string {
  if (metric.name === "Server") return "API, file watching, session streams, and agent I/O"
  if (metric.name === "Renderer") return "React rendering, markdown, layout, and animations"
  if (metric.name === "GPU") return "Compositing, animation, and visual effects"
  if (metric.name === "App") return "Electron window and application lifecycle"
  return metric.type
}

function diagnosis(totalCpu: number, hottest?: ElectronProcessMetric, systemLeaks = 0): string {
  if (systemLeaks > 0) {
    return systemLeaks === 1
      ? '1 agent process outside Cogpit looks leaked — it drains the battery even while Cogpit itself is idle. See "Agent processes" below.'
      : `${systemLeaks} agent processes outside Cogpit look leaked — they drain the battery even while Cogpit itself is idle. See "Agent processes" below.`
  }
  if (totalCpu < 5) return "Cogpit is currently idle. Leave this open while the power spike happens."
  if (!hottest) return "The server is active. The lists below show its busiest recent work."
  if (hottest.name === "Server") {
    return "The server is doing the most work. Compare the activity and API lists below to find the hot loop."
  }
  if (hottest.name === "Renderer") {
    return "The renderer is doing the most work, which points to repeated UI rendering, layout, or animation."
  }
  if (hottest.name === "GPU") {
    return "The GPU process is doing the most work, which points to continuous compositing or visual effects."
  }
  return `${hottest.name} is currently the busiest Cogpit process.`
}

function ProcessRow({ metric }: { metric: ElectronProcessMetric }) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{metric.name}</span>
          {metric.pid > 0 && <Badge variant="outline">PID {metric.pid}</Badge>}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{processHint(metric)}</p>
      </div>
      <div className="shrink-0 text-right">
        <div className={cn(
          "font-mono text-sm font-semibold tabular-nums",
          metric.cpuPercent >= 50 && "text-destructive",
        )}>
          {formatCpu(metric.cpuPercent)}
        </div>
        <div className="text-xs text-muted-foreground">{formatMemory(metric.memoryMb)}</div>
        {metric.idleWakeupsPerSecond !== undefined && metric.idleWakeupsPerSecond > 0 && (
          <div className="text-xs text-muted-foreground">
            {metric.idleWakeupsPerSecond.toFixed(0)} wakeups/s
          </div>
        )}
      </div>
    </div>
  )
}

function ActivityRows({ metrics, emptyLabel }: { metrics: ActivityMetric[]; emptyLabel: string }) {
  const visible = metrics.slice(0, 8)
  if (visible.length === 0) {
    return <p className="py-3 text-sm text-muted-foreground">{emptyLabel}</p>
  }

  return visible.map((metric, index) => {
    const bytes = formatBytesPerSecond(metric.bytesPerSecond)
    return (
      <div key={metric.name}>
        {index > 0 && <Separator />}
        <div className="flex items-center gap-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">{metric.name}</div>
            <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
              <span>{formatRate(metric.ratePerSecond)}</span>
              {bytes && <span>{bytes}</span>}
              {metric.averageDurationMs !== undefined && (
                <span>{metric.averageDurationMs.toFixed(0)} ms avg</span>
              )}
            </div>
          </div>
          {metric.active !== undefined && metric.active > 0 && (
            <Badge variant="secondary">{metric.active} open</Badge>
          )}
        </div>
      </div>
    )
  })
}

function CpuHistory({ values }: { values: number[] }) {
  const ceiling = Math.max(100, ...values)
  return (
    <div
      className="flex h-14 items-end gap-1 rounded-md bg-muted/50 p-2"
      role="img"
      aria-label={`Recent Cogpit CPU: ${values.map((value) => formatCpu(value)).join(", ")}`}
    >
      {values.length === 0 ? (
        <span className="self-center text-xs text-muted-foreground">Collecting samples…</span>
      ) : values.map((value, index) => (
        <div
          // Sampling order is stable and samples have no separate identity.
          key={index}
          className={cn(
            "min-w-1 flex-1 rounded-sm bg-primary/70",
            value >= 80 && "bg-destructive/80",
          )}
          style={{ height: `${Math.max(4, Math.min(100, (value / ceiling) * 100))}%` }}
          title={formatCpu(value)}
        />
      ))}
    </div>
  )
}

export function PowerMonitor() {
  const [open, setOpen] = useState(false)
  const [electronSnapshot, setElectronSnapshot] = useState<ElectronPerformanceSnapshot | null>(null)
  const [serverSnapshot, setServerSnapshot] = useState<ServerPerformanceSnapshot | null>(null)
  const [history, setHistory] = useState<number[]>([])
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const refreshInFlight = useRef(false)
  const [copied, copy] = useCopyWithFeedback()

  async function refresh() {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    setRefreshing(true)

    const serverPromise = authFetch("/api/performance").then(async (response) => {
      if (!response.ok) throw new Error(`Server monitor returned ${response.status}`)
      return response.json() as Promise<ServerPerformanceSnapshot>
    })
    const electronPromise = window.electronPerformance?.getSnapshot() ?? Promise.resolve(null)
    const [serverResult, electronResult] = await Promise.allSettled([serverPromise, electronPromise])

    const nextServer = serverResult.status === "fulfilled" ? serverResult.value : null
    const nextElectron = electronResult.status === "fulfilled" ? electronResult.value : null
    if (nextServer) setServerSnapshot(nextServer)
    if (nextElectron) setElectronSnapshot(nextElectron)

    if (!nextServer && !nextElectron) {
      setError("Performance data is unavailable.")
    } else {
      setError(null)
      const totalCpu = nextElectron && nextElectron.processes.length > 0
        ? nextElectron.processes.reduce((sum, metric) => sum + metric.cpuPercent, 0)
        : nextServer?.cpuPercent ?? 0
      setHistory((current) => [...current.slice(-(MAX_HISTORY_SAMPLES - 1)), totalCpu])
    }

    refreshInFlight.current = false
    setRefreshing(false)
  }

  const refreshOnInterval = useEffectEvent(() => {
    void refresh()
  })

  useEffect(() => {
    if (!open) return
    const interval = window.setInterval(refreshOnInterval, POLL_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [open, refreshOnInterval])

  const processes = [...(electronSnapshot?.processes ?? [])]
    .sort((a, b) => b.cpuPercent - a.cpuPercent)
  const totalCpu = processes.length > 0
    ? processes.reduce((sum, metric) => sum + metric.cpuPercent, 0)
    : serverSnapshot?.cpuPercent ?? 0
  const hottest = processes[0]
  const systemProcesses = serverSnapshot?.system?.processes ?? []
  const systemLeaks = serverSnapshot?.system?.suspectedLeakCount ?? 0
  const status = systemLeaks > 0 || totalCpu >= 80 ? "High" : totalCpu >= 15 ? "Active" : "Idle"

  const handleKillProcess = async (pid: number) => {
    try {
      await authFetch("/api/system-processes/kill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pids: [pid] }),
      })
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    } catch {
      // Best-effort; the refresh below shows the real state.
    }
    void refresh()
  }

  const handleCopy = () => {
    copy(JSON.stringify({
      capturedAt: new Date().toISOString(),
      electron: electronSnapshot,
      server: serverSnapshot,
      cpuHistory: history,
    }, null, 2))
  }

  return (
    <>
      <HeaderIconButton
        icon={Activity}
        label="Power & activity monitor"
        onClick={() => {
          setOpen(true)
          void refresh()
        }}
        className="text-muted-foreground hover:text-foreground"
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="h-[min(780px,calc(100vh-2rem))] gap-0 p-0 sm:max-w-3xl">
          <DialogHeader className="p-5 pb-4">
            <div className="flex items-start gap-3 pr-8">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <DialogTitle>Power & activity monitor</DialogTitle>
                  <Badge variant={status === "High" ? "destructive" : "secondary"}>{status}</Badge>
                </div>
                <DialogDescription className="mt-1">
                  Live CPU and wakeups are used as a power proxy. Sampling only runs while this window is open.
                </DialogDescription>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>
                  <RefreshCw data-icon="inline-start" className={cn(refreshing && "animate-spin")} />
                  Refresh
                </Button>
                <Button variant="outline" size="sm" onClick={handleCopy} disabled={!serverSnapshot && !electronSnapshot}>
                  {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
                  {copied ? "Copied" : "Copy data"}
                </Button>
              </div>
            </div>
          </DialogHeader>

          <Separator />

          <ScrollArea className="min-h-0 min-w-0 flex-1">
            <div className="flex flex-col gap-4 p-5">
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

              <Card size="sm">
                <CardHeader>
                  <CardTitle>Current load</CardTitle>
                  <CardDescription>{diagnosis(totalCpu, hottest, systemLeaks)}</CardDescription>
                  <CardAction>
                    <span className={cn(
                      "font-mono text-lg font-semibold tabular-nums",
                      totalCpu >= 80 && "text-destructive",
                    )}>
                      {formatCpu(totalCpu)} CPU
                    </span>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <CpuHistory values={history} />
                </CardContent>
              </Card>

              <Card size="sm">
                <CardHeader>
                  <CardTitle>Processes</CardTitle>
                  <CardDescription>Which part of Cogpit is consuming CPU and memory.</CardDescription>
                </CardHeader>
                <CardContent>
                  {processes.length > 0 ? processes.map((metric, index) => (
                    <div key={metric.pid}>
                      {index > 0 && <Separator />}
                      <ProcessRow metric={metric} />
                    </div>
                  )) : serverSnapshot ? (
                    <ProcessRow metric={{
                      pid: 0,
                      name: "Server",
                      type: "Node",
                      cpuPercent: serverSnapshot.cpuPercent,
                      memoryMb: serverSnapshot.memory.rssMb,
                    }} />
                  ) : (
                    <p className="py-3 text-sm text-muted-foreground">Collecting process data…</p>
                  )}
                </CardContent>
              </Card>

              {systemProcesses.length > 0 && (
                <Card size="sm">
                  <CardHeader>
                    <CardTitle>Agent processes</CardTitle>
                    <CardDescription>
                      Claude sessions, browsers, and scripts running system-wide. macOS bills
                      their energy to the app that spawned them, so a leaked one drains the
                      battery while the numbers above look idle.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {systemProcesses.map((metric, index) => (
                      <div key={metric.pid}>
                        {index > 0 && <Separator />}
                        <SystemProcessRow metric={metric} onKill={(pid) => void handleKillProcess(pid)} />
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <Card size="sm">
                  <CardHeader>
                    <CardTitle>Server activity</CardTitle>
                    <CardDescription>
                      File checks, streams, and agent work over the last {serverSnapshot?.sampleWindowSeconds ?? 10} seconds.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ActivityRows
                      metrics={serverSnapshot?.activities ?? []}
                      emptyLabel="No watched-file or stream activity in this sample."
                    />
                  </CardContent>
                </Card>

                <Card size="sm">
                  <CardHeader>
                    <CardTitle>API activity</CardTitle>
                    <CardDescription>Requests ranked by recent frequency and time.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ActivityRows
                      metrics={serverSnapshot?.requests ?? []}
                      emptyLabel="No API requests in this sample."
                    />
                  </CardContent>
                </Card>
              </div>

              {serverSnapshot && (
                <p className="text-xs text-muted-foreground">
                  Server event loop {formatCpu(serverSnapshot.eventLoopPercent)} · heap {formatMemory(serverSnapshot.memory.heapUsedMb)} · RSS {formatMemory(serverSnapshot.memory.rssMb)}
                </p>
              )}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  )
}
