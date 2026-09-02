import { useState, useMemo, useEffect, useCallback } from "react"
import { Server, Square, TerminalSquare } from "lucide-react"
import { cn } from "@/lib/utils"
import { authFetch } from "@/lib/auth"
import { SectionHeading } from "@/components/stats/SectionHeading"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { Turn } from "../../../shared/session/types"

// ── Types ───────────────────────────────────────────────────────────────────

interface BgTask {
  id: string
  outputPath: string | null
  ports: number[]
  portStatus: Record<number, boolean>
  preview: string
}

interface BackgroundServersProps {
  cwd: string
  turns: Turn[]
  onToggleServer?: (id: string, outputPath: string, title: string) => void
  onServersChanged?: (servers: { id: string; outputPath: string; title: string }[]) => void
}

// ── Port Detection ──────────────────────────────────────────────────────────

const PORT_RE = /(?::(\d{4,5}))|(?:port\s+(\d{4,5}))|(?:localhost:(\d{4,5}))/gi

function detectPorts(text: string): number[] {
  const ports = new Set<number>()
  for (const m of text.matchAll(PORT_RE)) {
    const p = parseInt(m[1] || m[2] || m[3], 10)
    if (p > 0 && p < 65536) ports.add(p)
  }
  return [...ports]
}

// ── JSONL Port Extraction ───────────────────────────────────────────────────

function useJsonlPorts(turns: Turn[]): Map<number, { description: string; outputPath: string | null }> {
  return useMemo(() => {
    const portMap = new Map<number, { description: string; outputPath: string | null }>()
    for (let i = 0; i < turns.length; i++) {
      for (const tc of turns[i].toolCalls) {
        if (tc.name !== "Bash" || !tc.input.run_in_background) continue
        const command = (tc.input.command as string) || ""
        const description = (tc.input.description as string) || ""
        const assistantText = turns[i].assistantText?.join(" ") || ""
        const allText = [command, description, tc.result || "", assistantText].join(" ")
        const ports = detectPorts(allText)
        if (ports.length === 0) {
          const devCmd = command.toLowerCase()
          if (devCmd.includes("run dev") || devCmd.includes("next dev") || devCmd.includes("vite")) {
            ports.push(3000)
          }
        }
        const outputMatch = (tc.result || "").match(/Output is being written to:\s*(\S+)/)
        const outputPath = outputMatch ? outputMatch[1] : null
        for (const port of ports) {
          portMap.set(port, { description: description || command.replace(/^cd\s+"[^"]*"\s*&&\s*/, "").slice(0, 60), outputPath })
        }
      }
    }
    return portMap
  }, [turns])
}

// ── Task Title Helper ───────────────────────────────────────────────────────

function getTaskTitle(task: BgTask): string {
  return task.preview.split("\n").find((l) => l.trim())?.trim() || `Task ${task.id}`
}

// ── Port Badge ──────────────────────────────────────────────────────────────

function PortBadge({ port, isActive }: { port: number; isActive: boolean }): React.JSX.Element {
  return (
    <Badge variant="secondary" className="font-mono">
      <span
        className={cn(
          "inline-block size-1.5 rounded-full",
          isActive ? "bg-success" : "bg-muted-foreground/40"
        )}
      />
      <span className={isActive ? "text-success" : "text-muted-foreground"}>
        :{port}
      </span>
    </Badge>
  )
}

// ── Main Component ──────────────────────────────────────────────────────────

export function BackgroundServers({
  cwd,
  turns,
  onToggleServer,
  onServersChanged,
}: BackgroundServersProps): React.JSX.Element | null {
  const [tasks, setTasks] = useState<BgTask[]>([])
  const jsonlPorts = useJsonlPorts(turns)

  // Poll the background-tasks API, fall back to JSONL port checking
  useEffect(() => {
    if (!cwd) return

    let cancelled = false
    async function check() {
      try {
        const res = await authFetch(
          `/api/background-tasks?cwd=${encodeURIComponent(cwd)}`
        )
        if (cancelled) return
        if (res.ok) {
          const apiTasks: BgTask[] = await res.json()
          if (cancelled) return
          if (apiTasks.length > 0) {
            setTasks(apiTasks)
            return
          }
        }

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
          if (cancelled) return
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
        title: getTaskTitle(t),
      }))
    onServersChanged(discovered)
  }, [tasks, onServersChanged])

  if (tasks.length === 0) return null

  return (
    <section>
      <SectionHeading>Active Servers ({tasks.length})</SectionHeading>
      <div className="flex flex-col gap-1.5">
        {tasks.map((task) => {
          const activePorts = task.ports.filter((p) => task.portStatus[p])
          const title = getTaskTitle(task)

          return (
            <div
              key={task.id}
              className="border-b border-border px-2 py-2 last:border-b-0"
            >
              <div className="flex items-center gap-1.5">
                  <Server className="size-3 shrink-0 text-success" data-icon="inline-start" />
                  <span className="truncate text-xs font-medium text-foreground">
                    {title}
                  </span>
              </div>

              <div className="mt-1.5 flex items-center gap-1.5">
                {task.ports.map((port) => (
                  <PortBadge key={port} port={port} isActive={task.portStatus[port]} />
                ))}

                <div className="flex-1" />

                {task.outputPath && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => onToggleServer?.(task.id, task.outputPath!, title)}
                    title="View server output"
                    aria-label="View server output"
                  >
                    <TerminalSquare data-icon="inline-start" />
                  </Button>
                )}
                {activePorts.length > 0 && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-destructive"
                    onClick={() => activePorts.forEach((p) => handleKillPort(p))}
                    title="Stop server"
                    aria-label="Stop server"
                  >
                    <Square data-icon="inline-start" className="fill-current" />
                    <span>Stop</span>
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
