import { useMemo, useState, useCallback, useEffect, useRef, memo } from "react"
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
  Bot,
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
import { formatTokenCount, truncate, parseSubAgentPath } from "@/lib/format"
import { formatCost, calculateCost, estimateThinkingTokens, estimateVisibleOutputTokens } from "@/lib/token-costs"
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
  /** Called when user clicks a background agent to open its session */
  onLoadSession?: (dirName: string, fileName: string) => void
  /** Current session source for detecting sub-agent view */
  sessionSource?: { dirName: string; fileName: string } | null
  /** Background agents from useBackgroundAgents (passed from App to avoid double-polling) */
  backgroundAgents?: BgAgent[]
}

// ── Token Usage Per Turn Chart ─────────────────────────────────────────────

function InputOutputChart({ turns }: { turns: Turn[] }) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

  const data = useMemo(() => {
    return turns.map((t, i) => {
      const newInput = t.tokenUsage?.input_tokens ?? 0
      const cacheRead = t.tokenUsage?.cache_read_input_tokens ?? 0
      const cacheWrite = t.tokenUsage?.cache_creation_input_tokens ?? 0
      const totalInput = newInput + cacheRead + cacheWrite
      const hasSubAgents = t.subAgentActivity.length > 0

      // Estimate output from actual content (JSONL output_tokens is unreliable)
      const thinkingTokens = estimateThinkingTokens(t)
      const visibleTokens = estimateVisibleOutputTokens(t)
      const totalOutput = Math.max(thinkingTokens + visibleTokens, t.tokenUsage?.output_tokens ?? 0)

      const cost = t.tokenUsage
        ? calculateCost({ model: t.model, inputTokens: newInput, outputTokens: totalOutput, cacheWriteTokens: cacheWrite, cacheReadTokens: cacheRead })
        : 0

      return {
        turn: i + 1,
        totalInput,
        totalOutput,
        thinkingTokens,
        visibleTokens,
        newInput,
        cacheRead,
        cacheWrite,
        hasSubAgents,
        cost,
      }
    })
  }, [turns])

  if (data.length === 0) return null

  const maxInput = Math.max(...data.map((d) => d.totalInput))
  const maxOutput = Math.max(...data.map((d) => d.totalOutput))
  const maxVal = Math.max(maxInput, maxOutput)
  if (maxVal === 0) return null

  const svgWidth = 280
  const svgHeight = 130
  const padTop = 16
  const padBottom = 22
  const padLeft = 36
  const padRight = 8
  const chartW = svgWidth - padLeft - padRight
  const chartH = svgHeight - padTop - padBottom
  // Each turn gets a group: input bar + output bar + gap between groups
  const groupW = Math.max(5, Math.min(20, chartW / data.length))
  const barW = Math.max(2, (groupW - 1) / 2)

  const hovered = hoveredIdx !== null ? data[hoveredIdx] : null

  return (
    <section className="relative">
      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <span className="h-3.5 w-0.5 rounded-full bg-blue-500/40" />
        Input / Output Per Turn
      </h3>

      {/* Tooltip overlapping the chart (stays within overflow bounds) */}
      {hovered && (
        <div className="pointer-events-none absolute left-0 right-0 top-[28px] z-10 px-1">
          <div className="rounded-md border border-border bg-elevation-2 px-2.5 py-2 text-[10px] shadow-lg w-fit">
            <div className="font-medium text-foreground mb-1">Turn {hovered.turn}</div>
            <div className="flex flex-col gap-0.5 text-muted-foreground">
              <span>Input: <span className="text-blue-400">{formatTokenCount(hovered.totalInput)}</span>
                <span className="text-[9px] ml-1 opacity-60">
                  ({formatTokenCount(hovered.cacheRead)} cached, {formatTokenCount(hovered.cacheWrite)} written, {formatTokenCount(hovered.newInput)} new)
                </span>
              </span>
              <span>Output: <span className="text-green-400">{formatTokenCount(hovered.totalOutput)}</span>
                {hovered.thinkingTokens > 0 && (
                  <span className="text-[9px] ml-1 opacity-60">
                    ({formatTokenCount(hovered.thinkingTokens)} thinking, {formatTokenCount(hovered.visibleTokens)} text)
                  </span>
                )}
              </span>
              {hovered.cost > 0 && <span>Cost: <span className="text-amber-400">~{formatCost(hovered.cost)}</span></span>}
              {hovered.hasSubAgents && <span className="text-amber-400/70">Has sub-agent activity</span>}
            </div>
          </div>
        </div>
      )}

      <svg
        width="100%"
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        onMouseLeave={() => setHoveredIdx(null)}
      >
        {/* Y-axis labels */}
        <text x={padLeft - 4} y={padTop} textAnchor="end" dominantBaseline="central" className="fill-muted-foreground text-[8px]">
          {formatTokenCount(maxVal)}
        </text>
        <text x={padLeft - 4} y={padTop + chartH} textAnchor="end" dominantBaseline="central" className="fill-muted-foreground text-[8px]">
          0
        </text>
        {/* Grid line */}
        <line x1={padLeft} y1={padTop + chartH} x2={padLeft + chartW} y2={padTop + chartH} stroke="var(--border)" strokeWidth={0.5} />

        {data.map((d, i) => {
          const groupX = padLeft + (data.length === 1 ? (chartW - groupW) / 2 : (i / (data.length - 1)) * (chartW - groupW))
          const baseY = padTop + chartH

          // Input bar: stacked cache_read / cache_write / new
          const cacheReadH = (d.cacheRead / maxVal) * chartH
          const cacheWriteH = (d.cacheWrite / maxVal) * chartH
          const newInputH = (d.newInput / maxVal) * chartH

          // Output bar: stacked thinking (dim) / visible (bright)
          const thinkingH = (d.thinkingTokens / maxVal) * chartH
          const visibleH = (d.visibleTokens / maxVal) * chartH

          const isHovered = hoveredIdx === i

          return (
            <g
              key={i}
              onMouseEnter={() => setHoveredIdx(i)}
              style={{ cursor: "crosshair" }}
            >
              {/* Invisible hover target for the full group width */}
              <rect x={groupX} y={padTop} width={groupW} height={chartH} fill="transparent" />

              {/* Hover highlight */}
              {isHovered && (
                <rect x={groupX - 1} y={padTop} width={groupW + 2} height={chartH} fill="var(--foreground)" opacity={0.04} rx={2} />
              )}

              {/* Input bar — left half */}
              {cacheReadH > 0 && (
                <rect x={groupX} y={baseY - cacheReadH} width={barW} height={cacheReadH} rx={1} fill="#60a5fa" opacity={isHovered ? 0.45 : 0.25} />
              )}
              {cacheWriteH > 0 && (
                <rect x={groupX} y={baseY - cacheReadH - cacheWriteH} width={barW} height={cacheWriteH} rx={1} fill="#60a5fa" opacity={isHovered ? 0.7 : 0.5} />
              )}
              {newInputH > 0 && (
                <rect x={groupX} y={baseY - cacheReadH - cacheWriteH - newInputH} width={barW} height={newInputH} rx={1} fill="#60a5fa" opacity={isHovered ? 1 : 0.85} />
              )}

              {/* Output bar — right half: thinking (dim purple) + visible (bright green) */}
              {thinkingH > 0 && (
                <rect x={groupX + barW + 1} y={baseY - thinkingH} width={barW} height={thinkingH} rx={1} fill="#a78bfa" opacity={isHovered ? 0.7 : 0.45} />
              )}
              {visibleH > 0 && (
                <rect x={groupX + barW + 1} y={baseY - thinkingH - visibleH} width={barW} height={visibleH} rx={1} fill="#4ade80" opacity={isHovered ? 0.95 : 0.7} />
              )}

              {/* Sub-agent indicator dot */}
              {d.hasSubAgents && (
                <circle cx={groupX + groupW / 2} cy={baseY + 5} r={1.5} fill="#f59e0b" opacity={0.8} />
              )}
            </g>
          )
        })}

        {/* Legend */}
        <rect x={padLeft} y={svgHeight - 10} width={6} height={6} rx={1.5} fill="#60a5fa" opacity={0.85} />
        <text x={padLeft + 9} y={svgHeight - 4} className="fill-muted-foreground text-[7px]">Input</text>
        <rect x={padLeft + 38} y={svgHeight - 10} width={6} height={6} rx={1.5} fill="#4ade80" opacity={0.7} />
        <text x={padLeft + 47} y={svgHeight - 4} className="fill-muted-foreground text-[7px]">Output</text>
        <rect x={padLeft + 76} y={svgHeight - 10} width={6} height={6} rx={1.5} fill="#a78bfa" opacity={0.45} />
        <text x={padLeft + 85} y={svgHeight - 4} className="fill-muted-foreground text-[7px]">Think</text>
        <circle cx={padLeft + 112} cy={svgHeight - 7} r={2} fill="#f59e0b" opacity={0.8} />
        <text x={padLeft + 117} y={svgHeight - 4} className="fill-muted-foreground text-[7px]">Agent</text>
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
      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
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
          <div className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-elevation-2 px-2 py-1 text-[10px] text-foreground depth-low">
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
      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <span className="h-3.5 w-0.5 rounded-full bg-blue-500/40" />
        Models
      </h3>
      <div className="space-y-1">
        {models.map(([model, count]) => (
          <div
            key={model}
            className="flex items-center justify-between rounded border border-border elevation-2 depth-low px-2.5 py-1.5 text-[11px]"
          >
            <span className="truncate text-foreground">{model}</span>
            <span className="ml-2 shrink-0 text-muted-foreground">{count}</span>
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
      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <span className="h-3.5 w-0.5 rounded-full bg-blue-500/40" />
        Errors ({errors.length})
      </h3>
      <div className="max-h-[300px] overflow-y-auto space-y-1.5 pr-1">
        {errors.map((err, i) => (
          <button
            key={i}
            onClick={() => onJumpToTurn?.(err.turnIndex)}
            className="w-full rounded-lg border border-red-900/40 bg-red-950/20 depth-low px-3 py-2.5 text-left transition-colors hover:bg-red-950/40 hover:border-red-800/40"
          >
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="font-medium text-red-400">{err.toolName}</span>
              <span className="text-muted-foreground">Turn {err.turnIndex + 1}</span>
            </div>
            <div className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-muted-foreground">
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
      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
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
                  <span className="truncate text-[11px] font-medium text-foreground">
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
                        task.portStatus[port] ? "bg-green-400" : "bg-muted"
                      )}
                    />
                    <span className={task.portStatus[port] ? "text-green-400" : "text-muted-foreground"}>
                      :{port}
                    </span>
                  </span>
                ))}

                <div className="flex-1" />

                {task.outputPath && (
                  <button
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-elevation-2 hover:text-foreground"
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

// ── Agents Panel (background + inline sub-agents) ────────────────────────

const AGENT_BADGE_COLORS = [
  "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  "bg-amber-500/15 text-amber-300 border-amber-500/30",
  "bg-rose-500/15 text-rose-300 border-rose-500/30",
  "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
]

interface BgAgent {
  agentId: string
  dirName: string
  fileName: string
  parentSessionId: string
  modifiedAt: number
  isActive: boolean
  preview: string
}

/** Extract inline sub-agent IDs and first text preview from session content blocks */
function extractInlineAgents(session: ParsedSession): Array<{
  agentId: string
  preview: string
  isBackground: boolean
}> {
  const seen = new Map<string, { preview: string; isBackground: boolean }>()
  for (const turn of session.turns) {
    for (const block of turn.contentBlocks) {
      if (block.kind !== "sub_agent" && block.kind !== "background_agent") continue
      for (const msg of block.messages) {
        if (seen.has(msg.agentId)) continue
        const preview = msg.text[0]?.split("\n").find((l) => l.trim())?.trim() ?? ""
        seen.set(msg.agentId, { preview, isBackground: msg.isBackground })
      }
    }
  }
  return Array.from(seen.entries()).map(([agentId, info]) => ({
    agentId,
    ...info,
  }))
}

function AgentsPanel({
  session,
  sessionSource,
  bgAgents,
  onLoadSession,
}: {
  session: ParsedSession
  sessionSource?: { dirName: string; fileName: string } | null
  bgAgents: BgAgent[]
  onLoadSession?: (dirName: string, fileName: string) => void
}) {
  // Detect if we're currently viewing a sub-agent
  const subAgentView = useMemo(() => {
    if (!sessionSource) return null
    const parsed = parseSubAgentPath(sessionSource.fileName)
    if (!parsed) return null
    return { ...parsed, dirName: sessionSource.dirName }
  }, [sessionSource])

  // Extract inline sub-agents from session content blocks
  const currentInlineAgents = useMemo(() => extractInlineAgents(session), [session])

  // Cache parent session's inline agents so they persist when navigating to sub-agents.
  // When viewing the main session, update the cache. When viewing a sub-agent
  // (whose session has no sub_agent content blocks), use the cached parent list.
  const cachedInlineAgentsRef = useRef(currentInlineAgents)
  useEffect(() => {
    if (!subAgentView && currentInlineAgents.length > 0) {
      cachedInlineAgentsRef.current = currentInlineAgents
    }
  }, [subAgentView, currentInlineAgents])
  const inlineAgents = subAgentView && currentInlineAgents.length === 0
    ? cachedInlineAgentsRef.current
    : currentInlineAgents

  // Determine the parent session ID for constructing sub-agent paths
  const parentSessionId = useMemo(() => {
    if (subAgentView) return subAgentView.parentSessionId
    // If viewing main session, extract sessionId from fileName (e.g. "abc123.jsonl" -> "abc123")
    if (sessionSource?.fileName) {
      const match = sessionSource.fileName.match(/^([^/]+)\.jsonl$/)
      if (match) return match[1]
    }
    return null
  }, [subAgentView, sessionSource])

  // Filter background agents to only those belonging to the current session
  const sessionBgAgents = useMemo(() => {
    if (!parentSessionId) return bgAgents
    return bgAgents.filter((a) => a.parentSessionId === parentSessionId)
  }, [bgAgents, parentSessionId])

  // Build combined list: background agents + inline-only sub-agents (deduplicated)
  const inlineOnlyAgents = useMemo(() => {
    const bgAgentIds = new Set(sessionBgAgents.map((a) => a.agentId))
    return inlineAgents.filter(
      (a) => !a.isBackground && !bgAgentIds.has(a.agentId)
    )
  }, [sessionBgAgents, inlineAgents])

  const totalCount = sessionBgAgents.length + inlineOnlyAgents.length
  if (totalCount === 0) return null

  // Determine which agent is currently being viewed
  const currentAgentId = subAgentView?.agentId ?? null

  return (
    <section>
      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <span className="h-3.5 w-0.5 rounded-full bg-blue-500/40" />
        Sub-Agents ({totalCount})
      </h3>

      {/* Back to Main button when viewing a sub-agent */}
      {subAgentView && onLoadSession && (
        <button
          onClick={() => onLoadSession(subAgentView.dirName, subAgentView.parentFileName)}
          className="mb-2 flex w-full items-center gap-1.5 rounded border border-blue-500/30 bg-blue-500/10 px-2.5 py-1.5 text-[11px] font-medium text-blue-400 transition-colors hover:bg-blue-500/20 hover:border-blue-500/50"
        >
          <ChevronRight className="size-3 rotate-180" />
          Back to Main Agent
        </button>
      )}

      <div className="max-h-[280px] overflow-y-auto space-y-1.5 pr-0.5">
        {/* Background agents */}
        {sessionBgAgents.map((agent, idx) => {
          const badgeColor = AGENT_BADGE_COLORS[idx % AGENT_BADGE_COLORS.length]
          const shortId = agent.agentId.length > 8 ? agent.agentId.slice(0, 8) : agent.agentId
          const preview = agent.preview
            ? agent.preview.split("\n").find((l) => l.trim())?.trim() ?? agent.agentId
            : agent.agentId
          const isViewing = currentAgentId === agent.agentId

          return (
            <button
              key={agent.agentId}
              onClick={() => onLoadSession?.(agent.dirName, agent.fileName)}
              className={cn(
                "w-full rounded border elevation-2 depth-low px-2.5 py-2 text-left transition-colors disabled:cursor-default",
                isViewing
                  ? "border-blue-500/50 bg-blue-500/10 ring-1 ring-blue-500/30"
                  : "border-border hover:bg-elevation-3"
              )}
              disabled={!onLoadSession}
            >
              <div className="flex items-center gap-1.5">
                <Bot className="size-3 shrink-0 text-indigo-400" />
                <span
                  className={cn(
                    "inline-flex items-center rounded border px-1.5 py-0 text-[10px] font-mono",
                    badgeColor
                  )}
                >
                  {shortId}
                </span>
                <span className="text-[9px] text-violet-400/70 font-medium uppercase">bg</span>
                {isViewing && (
                  <span className="text-[9px] text-blue-400 font-medium">viewing</span>
                )}
                <span
                  className={cn(
                    "ml-auto inline-block size-1.5 rounded-full shrink-0",
                    agent.isActive ? "bg-green-400 animate-pulse" : "bg-muted"
                  )}
                  title={agent.isActive ? "Active" : "Done"}
                />
              </div>
              {preview !== agent.agentId && (
                <p className="mt-1 truncate text-[10px] text-muted-foreground leading-snug">
                  {preview}
                </p>
              )}
            </button>
          )
        })}

        {/* Inline sub-agents (non-background) */}
        {inlineOnlyAgents.map((agent, idx) => {
          const badgeColor = AGENT_BADGE_COLORS[(sessionBgAgents.length + idx) % AGENT_BADGE_COLORS.length]
          const shortId = agent.agentId.length > 8 ? agent.agentId.slice(0, 8) : agent.agentId
          const isViewing = currentAgentId === agent.agentId

          // Construct the session path for this sub-agent
          const canNavigate = !!onLoadSession && !!parentSessionId && !!sessionSource
          const handleClick = () => {
            if (!canNavigate) return
            onLoadSession!(
              sessionSource!.dirName,
              `${parentSessionId}/subagents/agent-${agent.agentId}.jsonl`
            )
          }

          return (
            <button
              key={agent.agentId}
              onClick={handleClick}
              className={cn(
                "w-full rounded border elevation-2 depth-low px-2.5 py-2 text-left transition-colors disabled:cursor-default",
                isViewing
                  ? "border-blue-500/50 bg-blue-500/10 ring-1 ring-blue-500/30"
                  : "border-border hover:bg-elevation-3"
              )}
              disabled={!canNavigate}
            >
              <div className="flex items-center gap-1.5">
                <Bot className="size-3 shrink-0 text-cyan-400" />
                <span
                  className={cn(
                    "inline-flex items-center rounded border px-1.5 py-0 text-[10px] font-mono",
                    badgeColor
                  )}
                >
                  {shortId}
                </span>
                {isViewing && (
                  <span className="text-[9px] text-blue-400 font-medium">viewing</span>
                )}
              </div>
              {agent.preview && (
                <p className="mt-1 truncate text-[10px] text-muted-foreground leading-snug">
                  {agent.preview}
                </p>
              )}
            </button>
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
      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
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
                    ? "bg-elevation-2 text-foreground"
                    : "text-muted-foreground hover:bg-elevation-1 hover:text-foreground"
                )}
              >
                <span className="mt-0.5 shrink-0 text-[10px] font-mono text-muted-foreground">
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
  // Pre-compute per-turn cost share: turn cost / number of tool calls in that turn
  const turnCostShare = useMemo(() => turns.map((t) => {
    const u = t.tokenUsage
    if (!u || t.toolCalls.length === 0) return 0
    const estOutput = estimateThinkingTokens(t) + estimateVisibleOutputTokens(t)
    const output = Math.max(estOutput, u.output_tokens)
    return calculateCost({
      model: t.model,
      inputTokens: u.input_tokens,
      outputTokens: output,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
    }) / t.toolCalls.length
  }), [turns])

  const toolCallGroups = useMemo(() => {
    const groups = new Map<string, { calls: { tc: ToolCall; turnIndex: number }[]; count: number; estimatedCost: number }>()
    for (let i = 0; i < turns.length; i++) {
      for (const tc of turns[i].toolCalls) {
        if (!groups.has(tc.name)) {
          groups.set(tc.name, { calls: [], count: 0, estimatedCost: 0 })
        }
        const g = groups.get(tc.name)!
        g.calls.push({ tc, turnIndex: i })
        g.count++
        g.estimatedCost += turnCostShare[i]
      }
    }
    return Array.from(groups.entries()).sort((a, b) => b[1].count - a[1].count)
  }, [turns, turnCostShare])

  if (toolCallGroups.length === 0) return null

  return (
    <section>
      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
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
                  <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform [[data-state=open]>&]:rotate-90" />
                  <span className={cn("font-medium", colorClass)}>{name}</span>
                  <span className="ml-auto flex items-center gap-1.5">
                    {group.estimatedCost > 0 && (
                      <span className="text-[9px] font-mono text-amber-400/70">
                        ~{formatCost(group.estimatedCost)}
                      </span>
                    )}
                    <Badge
                      variant="secondary"
                      className="h-4 px-1.5 text-[10px] font-normal"
                    >
                      {group.count}
                    </Badge>
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="ml-4 flex flex-col gap-0.5 border-l border-border pl-2 pt-0.5">
                    {group.calls.slice(0, 50).map(({ tc, turnIndex }, i) => {
                      const preview = getToolCallPreview(tc)
                      return (
                        <div key={`${tc.id}-${i}`}>
                          <button
                            onClick={() => onJumpToTurn?.(turnIndex, tc.id)}
                            className={cn(
                              "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono text-left transition-colors w-full",
                              tc.isError
                                ? "text-red-400 hover:bg-red-950/30"
                                : "text-muted-foreground hover:bg-elevation-2 hover:text-foreground"
                            )}
                          >
                            {tc.isError && (
                              <AlertTriangle className="size-2.5 shrink-0 text-red-500" />
                            )}
                            <span className="truncate">
                              {preview || tc.id.slice(0, 8)}
                            </span>
                          </button>
                        </div>
                      )
                    })}
                    {group.calls.length > 50 && (
                      <div className="px-1.5 py-0.5 text-[10px] text-muted-foreground">
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

export const StatsPanel = memo(function StatsPanel({
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
  onLoadSession,
  sessionSource,
  backgroundAgents,
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
        <div className="sticky top-0 z-10 border-b border-border/50 bg-elevation-1">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
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
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery ?? ""}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Search..."
                className="w-full rounded-lg border border-border/60 elevation-2 depth-low py-2 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:border-blue-500/40 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-colors"
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
              <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
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
                        "rounded-md border px-2 py-1.5 text-[10px] font-medium transition-colors",
                        isSelected
                          ? "border-blue-500 text-blue-400 bg-blue-500/10"
                          : "border-border text-muted-foreground hover:border-border hover:text-foreground elevation-1"
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
            className="flex items-center justify-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-400 transition-colors hover:bg-amber-500/20 hover:border-amber-500/70"
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

        {/* Agents (background + inline sub-agents) */}
        <AgentsPanel
          session={session}
          sessionSource={sessionSource}
          bgAgents={backgroundAgents ?? []}
          onLoadSession={onLoadSession}
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

        {/* Input / Output Per Turn Chart */}
        <InputOutputChart turns={turns} />

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
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <RotateCcw className="size-4 text-amber-400" />
              Restart session?
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
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
              className="text-muted-foreground hover:text-foreground"
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
})
