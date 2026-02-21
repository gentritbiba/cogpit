import { useMemo, useState, useCallback, useEffect } from "react"
import {
  AlertTriangle,
  Server,
  Square,
  TerminalSquare,
  ChevronRight,
  Search,
  ChevronsDownUp,
  ChevronsUpDown,
  Cpu,
  RotateCcw,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible"
import { cn, MODEL_OPTIONS } from "@/lib/utils"
import { authFetch } from "@/lib/auth"
import type { ParsedSession, Turn, ToolCall } from "@/lib/types"
import { formatTokenCount, truncate } from "@/lib/format"
import { getUserMessageText, getToolColor } from "@/lib/parser"

// ── Props ──────────────────────────────────────────────────────────────────

interface StatsPanelProps {
  session: ParsedSession
  onJumpToTurn?: (turnIndex: number, toolCallId?: string) => void
  onToggleServer?: (id: string, outputPath: string, title: string) => void
  onServersChanged?: (servers: { id: string; outputPath: string; title: string }[]) => void
  /** When true, renders full-width mobile layout */
  isMobile?: boolean
  /** Search + expand controls (desktop only — passed when sidebar hosts search) */
  searchQuery?: string
  onSearchChange?: (query: string) => void
  expandAll?: boolean
  onToggleExpandAll?: () => void
  searchInputRef?: React.RefObject<HTMLInputElement | null>
  /** Permissions panel props */
  permissionsPanel?: React.ReactNode
  /** Model selector */
  selectedModel?: string
  onModelChange?: (model: string) => void
  /** Whether model or permissions have pending changes requiring restart */
  hasSettingsChanges?: boolean
  /** Called when user confirms restarting the session to apply settings */
  onApplySettings?: () => Promise<void>
}

// ── Token Usage Per Turn Chart ─────────────────────────────────────────────

function TokenChart({ turns }: { turns: Turn[] }) {
  const data = useMemo(() => {
    return turns.map((t, i) => {
      const newInput = t.tokenUsage?.input_tokens ?? 0
      const cacheRead = t.tokenUsage?.cache_read_input_tokens ?? 0
      const cacheWrite = t.tokenUsage?.cache_creation_input_tokens ?? 0
      return {
        turn: i + 1,
        // Total context = new + cache_creation + cache_read (real input to model)
        totalInput: newInput + cacheRead + cacheWrite,
        output: t.tokenUsage?.output_tokens ?? 0,
        // Sub-breakdown for stacking
        newInput,
        cacheRead,
        cacheWrite,
      }
    })
  }, [turns])

  if (data.length === 0) return null

  const maxVal = Math.max(...data.map((d) => d.totalInput))
  if (maxVal === 0) return null

  const svgWidth = 280
  const svgHeight = 120
  const padTop = 16
  const padBottom = 20
  const padLeft = 36
  const padRight = 8
  const chartW = svgWidth - padLeft - padRight
  const chartH = svgHeight - padTop - padBottom
  const barW = Math.max(2, Math.min(12, chartW / data.length - 1))

  return (
    <section>
      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
        <span className="h-3.5 w-0.5 rounded-full bg-blue-500/40" />
        Tokens Per Turn
      </h3>
      <svg width="100%" viewBox={`0 0 ${svgWidth} ${svgHeight}`}>
        {/* Y-axis labels */}
        <text
          x={padLeft - 4}
          y={padTop}
          textAnchor="end"
          dominantBaseline="central"
          className="fill-zinc-600 text-[8px]"
        >
          {formatTokenCount(maxVal)}
        </text>
        <text
          x={padLeft - 4}
          y={padTop + chartH}
          textAnchor="end"
          dominantBaseline="central"
          className="fill-zinc-600 text-[8px]"
        >
          0
        </text>
        {/* Grid line */}
        <line
          x1={padLeft}
          y1={padTop + chartH}
          x2={padLeft + chartW}
          y2={padTop + chartH}
          stroke="#3f3f46"
          strokeWidth={0.5}
        />

        {data.map((d, i) => {
          const x =
            padLeft + (data.length === 1 ? chartW / 2 : (i / (data.length - 1)) * (chartW - barW))

          // Stacked input bar: cache_read (bottom) + cache_write (middle) + new (top)
          const cacheReadH = (d.cacheRead / maxVal) * chartH
          const cacheWriteH = (d.cacheWrite / maxVal) * chartH
          const newInputH = (d.newInput / maxVal) * chartH
          const totalInputH = cacheReadH + cacheWriteH + newInputH
          const inputBaseY = padTop + chartH

          // Output tokens bar (green, next to input)
          const outputH = (d.output / maxVal) * chartH
          const outputY = padTop + chartH - outputH

          return (
            <g key={i}>
              {/* Cache read (bottom of stack, lightest) */}
              {cacheReadH > 0 && (
                <rect
                  x={x}
                  y={inputBaseY - cacheReadH}
                  width={barW / 2}
                  height={cacheReadH}
                  rx={2}
                  fill="#60a5fa"
                  opacity={0.25}
                />
              )}
              {/* Cache write (middle of stack) */}
              {cacheWriteH > 0 && (
                <rect
                  x={x}
                  y={inputBaseY - cacheReadH - cacheWriteH}
                  width={barW / 2}
                  height={cacheWriteH}
                  rx={2}
                  fill="#60a5fa"
                  opacity={0.5}
                />
              )}
              {/* New input tokens (top of stack, darkest) */}
              {newInputH > 0 && (
                <rect
                  x={x}
                  y={inputBaseY - totalInputH}
                  width={barW / 2}
                  height={newInputH}
                  rx={2}
                  fill="#60a5fa"
                  opacity={0.85}
                />
              )}
              {/* Output tokens */}
              <rect
                x={x + barW / 2}
                y={outputY}
                width={barW / 2}
                height={outputH}
                rx={2}
                fill="#4ade80"
                opacity={0.75}
              />
            </g>
          )
        })}

        {/* Legend */}
        <rect x={padLeft} y={svgHeight - 10} width={6} height={6} rx={2} fill="#60a5fa" opacity={0.85} />
        <text x={padLeft + 9} y={svgHeight - 4} className="fill-zinc-500 text-[7px]">New</text>
        <rect x={padLeft + 30} y={svgHeight - 10} width={6} height={6} rx={2} fill="#60a5fa" opacity={0.25} />
        <text x={padLeft + 39} y={svgHeight - 4} className="fill-zinc-500 text-[7px]">Cache</text>
        <rect x={padLeft + 65} y={svgHeight - 10} width={6} height={6} rx={2} fill="#4ade80" opacity={0.75} />
        <text x={padLeft + 74} y={svgHeight - 4} className="fill-zinc-500 text-[7px]">Output</text>
      </svg>
    </section>
  )
}

// ── Activity Heatmap ───────────────────────────────────────────────────────

function ActivityHeatmap({ turns }: { turns: Turn[] }) {
  const [hoveredTurn, setHoveredTurn] = useState<number | null>(null)

  const maxToolCalls = useMemo(
    () => Math.max(1, ...turns.map((t) => t.toolCalls.length)),
    [turns]
  )

  if (turns.length === 0) return null

  const svgWidth = 280
  const svgHeight = 32
  const segW = Math.max(2, Math.min(20, svgWidth / turns.length))
  const totalW = segW * turns.length

  return (
    <section>
      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
        <span className="h-3.5 w-0.5 rounded-full bg-blue-500/40" />
        Activity Heatmap
      </h3>
      <div className="relative">
        <svg width="100%" viewBox={`0 0 ${Math.max(svgWidth, totalW)} ${svgHeight}`}>
          {turns.map((t, i) => {
            const intensity = t.toolCalls.length / maxToolCalls
            const alpha = 0.1 + intensity * 0.9
            return (
              <rect
                key={i}
                x={i * segW}
                y={0}
                width={segW - 1}
                height={svgHeight}
                rx={2}
                fill="#60a5fa"
                opacity={alpha}
                onMouseEnter={() => setHoveredTurn(i)}
                onMouseLeave={() => setHoveredTurn(null)}
                className="cursor-pointer"
              />
            )
          })}
        </svg>
        {hoveredTurn !== null && (
          <div className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-elevation-2 px-2 py-1 text-[10px] text-zinc-300 depth-low">
            Turn {hoveredTurn + 1}: {turns[hoveredTurn].toolCalls.length} tool calls
          </div>
        )}
      </div>
    </section>
  )
}

// ── Model Distribution ─────────────────────────────────────────────────────

function ModelDistribution({ turns }: { turns: Turn[] }) {
  const models = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const t of turns) {
      if (t.model) {
        counts[t.model] = (counts[t.model] ?? 0) + 1
      }
    }
    return Object.entries(counts).sort(([, a], [, b]) => b - a)
  }, [turns])

  if (models.length <= 1) return null

  return (
    <section>
      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
        <span className="h-3.5 w-0.5 rounded-full bg-blue-500/40" />
        Models
      </h3>
      <div className="space-y-1">
        {models.map(([model, count]) => (
          <div
            key={model}
            className="flex items-center justify-between rounded border border-border elevation-2 depth-low px-2.5 py-1.5 text-[11px]"
          >
            <span className="truncate text-zinc-300">{model}</span>
            <span className="ml-2 shrink-0 text-zinc-500">{count}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

// ── Error Log ──────────────────────────────────────────────────────────────

function ErrorLog({
  turns,
  onJumpToTurn,
}: {
  turns: Turn[]
  onJumpToTurn?: (turnIndex: number, toolCallId?: string) => void
}) {
  const errors = useMemo(() => {
    const result: { turnIndex: number; toolName: string; message: string }[] = []
    for (let i = 0; i < turns.length; i++) {
      for (const tc of turns[i].toolCalls) {
        if (tc.isError && tc.result) {
          result.push({
            turnIndex: i,
            toolName: tc.name,
            message: tc.result.slice(0, 200),
          })
        }
      }
    }
    return result
  }, [turns])

  if (errors.length === 0) return null

  return (
    <section>
      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
        <span className="h-3.5 w-0.5 rounded-full bg-blue-500/40" />
        Errors ({errors.length})
      </h3>
      <div className="max-h-[300px] overflow-y-auto space-y-1.5 pr-1">
        {errors.map((err, i) => (
          <button
            key={i}
            onClick={() => onJumpToTurn?.(err.turnIndex)}
            className="w-full rounded-lg border border-red-900/40 bg-red-950/20 depth-low px-3 py-2.5 text-left transition-all hover:bg-red-950/40 hover:border-red-800/40"
          >
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="font-medium text-red-400">{err.toolName}</span>
              <span className="text-zinc-600">Turn {err.turnIndex + 1}</span>
            </div>
            <div className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-zinc-500">
              {err.message}
            </div>
          </button>
        ))}
      </div>
    </section>
  )
}

// ── Background Servers (scans Claude's task output directory + JSONL fallback) ─

interface BgTask {
  id: string
  outputPath: string | null
  ports: number[]
  portStatus: Record<number, boolean>
  preview: string
}

const PORT_RE = /(?::(\d{4,5}))|(?:port\s+(\d{4,5}))|(?:localhost:(\d{4,5}))/gi

function detectPorts(text: string): number[] {
  const ports = new Set<number>()
  for (const m of text.matchAll(PORT_RE)) {
    const p = parseInt(m[1] || m[2] || m[3], 10)
    if (p > 0 && p < 65536) ports.add(p)
  }
  return [...ports]
}

function BackgroundServers({
  cwd,
  turns,
  onToggleServer,
  onServersChanged,
}: {
  cwd: string
  turns: Turn[]
  onToggleServer?: (id: string, outputPath: string, title: string) => void
  onServersChanged?: (servers: { id: string; outputPath: string; title: string }[]) => void
}) {
  const [tasks, setTasks] = useState<BgTask[]>([])

  // Extract ports from JSONL background Bash commands (for fallback)
  const jsonlPorts = useMemo(() => {
    const portMap = new Map<number, { description: string; outputPath: string | null }>()
    for (let i = 0; i < turns.length; i++) {
      for (const tc of turns[i].toolCalls) {
        if (tc.name !== "Bash" || !tc.input.run_in_background) continue
        const command = (tc.input.command as string) || ""
        const description = (tc.input.description as string) || ""
        const assistantText = turns[i].assistantText?.join(" ") || ""
        const allText = [command, description, tc.result || "", assistantText].join(" ")
        const ports = detectPorts(allText)
        // Fallback for common dev commands
        if (ports.length === 0) {
          const devCmd = command.toLowerCase()
          if (devCmd.includes("run dev") || devCmd.includes("next dev") || devCmd.includes("vite")) {
            ports.push(3000)
          }
        }
        const outputMatch = (tc.result || "").match(/Output is being written to:\s*(\S+)/)
        const outputPath = outputMatch ? outputMatch[1] : null
        // Latest command per port wins
        for (const port of ports) {
          portMap.set(port, { description: description || command.replace(/^cd\s+"[^"]*"\s*&&\s*/, "").slice(0, 60), outputPath })
        }
      }
    }
    return portMap
  }, [turns])

  // Poll the background-tasks API, fall back to JSONL port checking
  useEffect(() => {
    if (!cwd) return

    let cancelled = false
    async function check() {
      try {
        // Primary: scan Claude's task output directory
        const res = await authFetch(
          `/api/background-tasks?cwd=${encodeURIComponent(cwd)}`
        )
        if (cancelled) return
        if (res.ok) {
          const apiTasks: BgTask[] = await res.json()
          if (apiTasks.length > 0) {
            setTasks(apiTasks)
            return
          }
        }

        // Fallback: check ports from JSONL tool calls
        if (jsonlPorts.size === 0) {
          setTasks([])
          return
        }
        const portsToCheck = [...jsonlPorts.keys()]
        const portRes = await authFetch(
          `/api/check-ports?ports=${portsToCheck.join(",")}`
        )
        if (cancelled) return
        if (portRes.ok) {
          const portStatus: Record<number, boolean> = await portRes.json()
          const fallbackTasks: BgTask[] = []
          const seen = new Set<number>()
          for (const [port, info] of jsonlPorts) {
            if (!portStatus[port] || seen.has(port)) continue
            seen.add(port)
            fallbackTasks.push({
              id: `port-${port}`,
              outputPath: info.outputPath,
              ports: [port],
              portStatus: { [port]: true },
              preview: info.description,
            })
          }
          setTasks(fallbackTasks)
        }
      } catch {
        // ignore
      }
    }
    check()
    const interval = setInterval(check, 10_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [cwd, jsonlPorts])

  const handleKillPort = useCallback(
    async (port: number) => {
      try {
        await authFetch("/api/kill-port", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ port }),
        })
        // Refresh after kill
        setTimeout(() => {
          setTasks((prev) => prev.filter((t) => !t.ports.includes(port)))
        }, 1500)
      } catch {
        /* ignore */
      }
    },
    []
  )

  // Report discovered servers to parent for the ServerPanel badges
  useEffect(() => {
    if (!onServersChanged) return
    const discovered = tasks
      .filter((t) => t.outputPath)
      .map((t) => ({
        id: t.id,
        outputPath: t.outputPath!,
        title:
          t.preview.split("\n").find((l) => l.trim())?.trim() ||
          `Task ${t.id}`,
      }))
    onServersChanged(discovered)
  }, [tasks, onServersChanged])

  if (tasks.length === 0) return null

  return (
    <section>
      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
        <span className="h-3.5 w-0.5 rounded-full bg-blue-500/40" />
        Active Servers ({tasks.length})
      </h3>
      <div className="space-y-1.5">
        {tasks.map((task) => {
          const activePorts = task.ports.filter((p) => task.portStatus[p])
          const title =
            task.preview.split("\n").find((l) => l.trim())?.trim() ||
            `Task ${task.id}`

          return (
            <div
              key={task.id}
              className="rounded border border-border elevation-2 depth-low px-2.5 py-2 transition-colors hover:bg-elevation-3"
            >
              <button
                className="w-full text-left"
                onClick={() =>
                  task.outputPath
                    ? onToggleServer?.(task.id, task.outputPath, title)
                    : undefined
                }
              >
                <div className="flex items-center gap-1.5">
                  <Server className="size-3 shrink-0 text-green-400" />
                  <span className="truncate text-[11px] font-medium text-zinc-300">
                    {title}
                  </span>
                </div>
              </button>

              <div className="mt-1.5 flex items-center gap-1.5">
                {task.ports.map((port) => (
                  <span
                    key={port}
                    className="inline-flex items-center gap-1 rounded bg-elevation-2 px-1.5 py-0.5 text-[10px] font-mono"
                  >
                    <span
                      className={cn(
                        "inline-block size-1.5 rounded-full",
                        task.portStatus[port] ? "bg-green-400" : "bg-zinc-600"
                      )}
                    />
                    <span className={task.portStatus[port] ? "text-green-400" : "text-zinc-500"}>
                      :{port}
                    </span>
                  </span>
                ))}

                <div className="flex-1" />

                {task.outputPath && (
                  <button
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:bg-elevation-2 hover:text-zinc-300"
                    onClick={() => onToggleServer?.(task.id, task.outputPath!, title)}
                    title="View server output"
                    aria-label="View server output"
                  >
                    <TerminalSquare className="size-3" />
                  </button>
                )}
                {activePorts.length > 0 && (
                  <button
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-red-400 hover:bg-red-950/50 hover:text-red-300"
                    onClick={() => activePorts.forEach((p) => handleKillPort(p))}
                    title="Stop server"
                    aria-label="Stop server"
                  >
                    <Square className="size-2.5 fill-current" />
                    <span>Stop</span>
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ── Turn Navigator ────────────────────────────────────────────────────────

function TurnNavigator({
  turns,
  onJumpToTurn,
}: {
  turns: Turn[]
  onJumpToTurn?: (turnIndex: number, toolCallId?: string) => void
}) {
  const [activeTurn, setActiveTurn] = useState<number | null>(null)

  if (turns.length === 0) return null

  return (
    <section>
      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
        <span className="h-3.5 w-0.5 rounded-full bg-blue-500/40" />
        Turns ({turns.length})
      </h3>
      <div className="max-h-[400px] overflow-y-auto">
        <div className="flex flex-col gap-0.5 pr-2">
          {turns.map((turn, i) => {
            const preview = getUserMessageText(turn.userMessage)
            const isActive = activeTurn === i
            return (
              <button
                key={turn.id}
                onClick={() => {
                  setActiveTurn(i)
                  onJumpToTurn?.(i)
                }}
                className={cn(
                  "group flex items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                  isActive
                    ? "bg-elevation-2 text-zinc-200"
                    : "text-zinc-400 hover:bg-elevation-1 hover:text-zinc-300"
                )}
              >
                <span className="mt-0.5 shrink-0 text-[10px] font-mono text-zinc-600">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs">
                  {preview ? truncate(preview, 50) : "(no message)"}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {turn.toolCalls.length > 0 && (
                    <Badge
                      variant="secondary"
                      className="h-4 px-1 text-[10px] font-normal"
                    >
                      {turn.toolCalls.length}
                    </Badge>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}

// ── Tool Call Index ────────────────────────────────────────────────────────

function getToolCallPreview(tc: ToolCall): string {
  const input = tc.input
  if (input.file_path && typeof input.file_path === "string")
    return input.file_path.split("/").slice(-2).join("/")
  if (input.command && typeof input.command === "string")
    return truncate(input.command, 40)
  if (input.pattern && typeof input.pattern === "string")
    return input.pattern
  if (input.query && typeof input.query === "string")
    return truncate(input.query, 40)
  if (input.url && typeof input.url === "string")
    return truncate(input.url, 40)
  return ""
}

function ToolCallIndex({
  turns,
  onJumpToTurn,
}: {
  turns: Turn[]
  onJumpToTurn?: (turnIndex: number, toolCallId?: string) => void
}) {
  const toolCallGroups = useMemo(() => {
    const groups = new Map<string, { calls: { tc: ToolCall; turnIndex: number }[]; count: number }>()
    for (let i = 0; i < turns.length; i++) {
      for (const tc of turns[i].toolCalls) {
        if (!groups.has(tc.name)) {
          groups.set(tc.name, { calls: [], count: 0 })
        }
        const g = groups.get(tc.name)!
        g.calls.push({ tc, turnIndex: i })
        g.count++
      }
    }
    return Array.from(groups.entries()).sort((a, b) => b[1].count - a[1].count)
  }, [turns])

  if (toolCallGroups.length === 0) return null

  return (
    <section>
      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
        <span className="h-3.5 w-0.5 rounded-full bg-blue-500/40" />
        Tool Calls
      </h3>
      <div className="max-h-[320px] overflow-y-auto">
        <div className="flex flex-col gap-0.5 pr-2">
          {toolCallGroups.map(([name, group]) => {
            const colorClass = getToolColor(name)
            return (
              <Collapsible key={name}>
                <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-elevation-1">
                  <ChevronRight className="size-3 shrink-0 text-zinc-600 transition-transform [[data-state=open]>&]:rotate-90" />
                  <span className={cn("font-medium", colorClass)}>{name}</span>
                  <Badge
                    variant="secondary"
                    className="ml-auto h-4 px-1.5 text-[10px] font-normal"
                  >
                    {group.count}
                  </Badge>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="ml-4 flex flex-col gap-0.5 border-l border-border pl-2 pt-0.5">
                    {group.calls.slice(0, 50).map(({ tc, turnIndex }, i) => {
                      const preview = getToolCallPreview(tc)
                      return (
                        <button
                          key={`${tc.id}-${i}`}
                          onClick={() => onJumpToTurn?.(turnIndex, tc.id)}
                          className={cn(
                            "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono text-left transition-colors",
                            tc.isError
                              ? "text-red-400 hover:bg-red-950/30"
                              : "text-zinc-500 hover:bg-elevation-2 hover:text-zinc-300"
                          )}
                        >
                          {tc.isError && (
                            <AlertTriangle className="size-2.5 shrink-0 text-red-500" />
                          )}
                          <span className="truncate">
                            {preview || tc.id.slice(0, 8)}
                          </span>
                        </button>
                      )
                    })}
                    {group.calls.length > 50 && (
                      <div className="px-1.5 py-0.5 text-[10px] text-zinc-600">
                        +{group.calls.length - 50} more
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )
          })}
        </div>
      </div>
    </section>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────

export function StatsPanel({
  session,
  onJumpToTurn,
  onToggleServer,
  onServersChanged,
  isMobile,
  searchQuery,
  onSearchChange,
  expandAll,
  onToggleExpandAll,
  searchInputRef,
  permissionsPanel,
  selectedModel,
  onModelChange,
  hasSettingsChanges,
  onApplySettings,
}: StatsPanelProps) {
  const { turns } = session

  const [showRestartDialog, setShowRestartDialog] = useState(false)
  const [isRestarting, setIsRestarting] = useState(false)

  const handleConfirmRestart = useCallback(async () => {
    if (!onApplySettings) return
    setIsRestarting(true)
    try {
      await onApplySettings()
      setShowRestartDialog(false)
    } finally {
      setIsRestarting(false)
    }
  }, [onApplySettings])

  return (
    <aside className={cn(
      "shrink-0 min-h-0 h-full overflow-y-auto elevation-1",
      isMobile ? "w-full flex-1 mobile-scroll" : "w-[300px] border-l border-border panel-enter-right"
    )}>
      {/* Header + Search bar (desktop only) */}
      {onSearchChange && (
        <div className="sticky top-0 z-10 border-b border-border/50 backdrop-blur-sm">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs font-medium text-zinc-300 flex items-center gap-1.5">
              <Search className="size-3" />
              Session
            </span>
            {onToggleExpandAll && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 shrink-0"
                onClick={onToggleExpandAll}
                aria-label={expandAll ? "Collapse all" : "Expand all"}
              >
                {expandAll ? (
                  <ChevronsDownUp className="size-3" />
                ) : (
                  <ChevronsUpDown className="size-3" />
                )}
              </Button>
            )}
          </div>
          <div className="px-2 pb-2 pt-1">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-500" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery ?? ""}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Search..."
                className="w-full rounded-lg border border-border/60 elevation-2 depth-low py-2 pl-8 pr-3 text-xs text-zinc-300 placeholder:text-zinc-500 focus:border-blue-500/40 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all"
              />
            </div>
          </div>
        </div>
      )}
      <div className={cn("flex flex-col gap-6", isMobile ? "p-4" : "p-3")}>
        {/* Permissions */}
        {permissionsPanel && (
          <div className="rounded-lg border border-border elevation-2 depth-low p-3">
            {permissionsPanel}
          </div>
        )}

        {/* Model Selector */}
        {onModelChange && (
          <div className="rounded-lg border border-border elevation-2 depth-low p-3">
            <section>
              <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
                <span className="h-3.5 w-0.5 rounded-full bg-blue-500/40" />
                <Cpu className="size-3" />
                Model
              </h3>
              <div className="grid grid-cols-2 gap-1">
                {MODEL_OPTIONS.map((opt) => {
                  const isSelected = (selectedModel || "") === opt.value
                  return (
                    <button
                      key={opt.value}
                      onClick={() => onModelChange(opt.value)}
                      className={cn(
                        "rounded-md border px-2 py-1.5 text-[10px] font-medium transition-all",
                        isSelected
                          ? "border-blue-500 text-blue-400 bg-blue-500/10"
                          : "border-border text-zinc-500 hover:border-zinc-600 hover:text-zinc-300 elevation-1"
                      )}
                    >
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            </section>
          </div>
        )}

        {/* Apply Settings Button */}
        {hasSettingsChanges && onApplySettings && (
          <button
            onClick={() => setShowRestartDialog(true)}
            className="flex items-center justify-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-400 transition-all hover:bg-amber-500/20 hover:border-amber-500/70"
          >
            <RotateCcw className="size-3" />
            Apply Changes
          </button>
        )}

        {/* Background Servers */}
        <BackgroundServers
          cwd={session.cwd}
          turns={turns}
          onToggleServer={onToggleServer}
          onServersChanged={onServersChanged}
        />

        {/* Turn Navigator */}
        <TurnNavigator
          turns={turns}
          onJumpToTurn={onJumpToTurn}
        />

        {/* Tool Call Index */}
        <ToolCallIndex
          turns={turns}
          onJumpToTurn={onJumpToTurn}
        />

        {/* Token Per Turn Chart */}
        <TokenChart turns={turns} />

        {/* Activity Heatmap */}
        <ActivityHeatmap turns={turns} />

        {/* Model Distribution */}
        <ModelDistribution turns={turns} />

        {/* Error Log */}
        <ErrorLog turns={turns} onJumpToTurn={onJumpToTurn} />
      </div>

      {/* Restart Confirmation Dialog */}
      <Dialog open={showRestartDialog} onOpenChange={(open) => { if (!open && !isRestarting) setShowRestartDialog(false) }}>
        <DialogContent className="sm:max-w-md elevation-4 border-border/30">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-zinc-100">
              <RotateCcw className="size-4 text-amber-400" />
              Restart session?
            </DialogTitle>
            <DialogDescription className="text-zinc-400">
              Applying new model or permission settings requires restarting the
              underlying Claude process. Your conversation history will be
              preserved, but the context cache will be cleared.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setShowRestartDialog(false)}
              disabled={isRestarting}
              className="text-zinc-400 hover:text-zinc-200"
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmRestart}
              disabled={isRestarting}
              className="bg-amber-600 hover:bg-amber-500 text-white"
            >
              {isRestarting ? "Restarting..." : "Apply & Restart"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  )
}
