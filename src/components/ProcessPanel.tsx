import { useState, useEffect, useRef, useCallback, memo, lazy, Suspense } from "react"
import { stripAnsi } from "@/lib/ansi"
import { authUrl } from "@/lib/auth"
import { ChevronDown, ChevronRight, Plus, TerminalSquare, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ProcessPanelScripts } from "@/components/ProcessPanelScripts"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import type { ProcessEntry } from "@/hooks/useProcessPanel"
import { usePty } from "@/contexts/PtyContext"

const TerminalOutput = lazy(() =>
  import("@/components/TerminalOutput").then((module) => ({ default: module.TerminalOutput })),
)

function ProcessOutput({
  process,
}: {
  process: ProcessEntry
}) {
  const [output, setOutput] = useState("")
  const [connected, setConnected] = useState(false)
  const outputRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    let url: string
    if (process.type === "task" && process.outputPath) {
      url = authUrl(`/api/task-output?path=${encodeURIComponent(process.outputPath)}`)
    } else {
      return
    }

    setOutput("")
    setConnected(false)

    const es = new EventSource(url)

    es.onopen = () => setConnected(true)

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.type === "output" && data.text) {
          const cleaned = stripAnsi(data.text)
          if (cleaned) {
            setOutput((prev) => {
              const next = prev + cleaned
              return next.length > 100_000 ? next.slice(-100_000) : next
            })
          }
        }
      } catch {
        // ignore malformed messages
      }
    }

    es.onerror = () => {
      // EventSource will auto-reconnect
    }

    return () => es.close()
  }, [process.id, process.type, process.outputPath])

  // Auto-scroll
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [output])

  return (
    <pre
      ref={outputRef}
      className="flex-1 overflow-auto bg-background px-3 py-2 font-mono text-xs leading-relaxed text-foreground whitespace-pre-wrap break-words"
    >
      {output || (
        <span className="text-muted-foreground">
          {connected ? "Waiting for output..." : "Connecting..."}
        </span>
      )}
    </pre>
  )
}

function ProcessTab({
  process,
  isActive,
  onSelectActive,
  onClose,
  mobile,
}: {
  process: ProcessEntry
  isActive: boolean
  onSelectActive: () => void
  onClose: () => void
  mobile: boolean
}) {
  return (
    <div
      title={process.source ?? process.name}
      className="inline-flex h-6 shrink-0 items-center"
    >
      <TabsTrigger
        value={process.id}
        aria-label={process.name}
        onClick={() => {
          if (isActive) onSelectActive()
        }}
        className={cn(
          "h-6 min-w-0 justify-start py-0 text-xs",
          mobile ? "gap-1 px-1.5" : "gap-1.5 px-2",
        )}
      >
        {process.status === "running" && (
          <span className="inline-block size-1.5 shrink-0 rounded-full bg-success" />
        )}
        {process.status === "errored" && (
          <span className="inline-block size-1.5 shrink-0 rounded-full bg-destructive" />
        )}

        <span className="truncate max-w-[100px]">{process.name}</span>

        <Badge
          variant="secondary"
          className={cn("px-1 py-0 font-normal", mobile && "hidden")}
        >
          {process.type}
        </Badge>
      </TabsTrigger>

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Close ${process.name}`}
        title={`Close ${process.name}`}
        onClick={onClose}
        className="mr-0.5 text-muted-foreground"
      >
        <X data-icon="inline-start" />
      </Button>
    </div>
  )
}

// ── Resize constants ────────────────────────────────────────────────────────

const MIN_HEIGHT = 100
const MAX_HEIGHT = 600
const DEFAULT_HEIGHT = 200
const HEIGHT_KEY = "process-panel-height"

function loadHeight(): number {
  try {
    const v = localStorage.getItem(HEIGHT_KEY)
    if (v) return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Number(v)))
  } catch { /* ignore */ }
  return DEFAULT_HEIGHT
}

// ── ProcessPanel — unified bottom panel ──────────────────────────────────────

interface ProcessPanelProps {
  processes: Map<string, ProcessEntry>
  activeProcessId: string | null
  collapsed: boolean
  onSetActive: (id: string) => void
  onRemove: (id: string) => void
  onToggleCollapse: () => void
  onRequestTerminal?: () => void
  onAddTerminalContext?: (text: string) => void
  onUpdateStatus?: (id: string, status: ProcessEntry["status"]) => void
  projectDir?: string | null
  onProcessStarted?: (entry: ProcessEntry) => void
  mobile?: boolean
}

export const ProcessPanel = memo(function ProcessPanel({
  processes,
  activeProcessId,
  collapsed,
  onSetActive,
  onRemove,
  onToggleCollapse,
  onRequestTerminal,
  onAddTerminalContext,
  onUpdateStatus,
  projectDir,
  onProcessStarted,
  mobile = false,
}: ProcessPanelProps) {
  const pty = usePty()
  const [height, setHeight] = useState(loadHeight)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

  // Sync PTY session status → ProcessPanel entries
  useEffect(() => {
    for (const session of pty.sessions) {
      if (session.status === "exited") {
        onUpdateStatus?.(session.id, "stopped")
      }
    }
  }, [pty.sessions, onUpdateStatus])

  const handleClose = useCallback((proc: ProcessEntry) => {
    if (proc.type !== "task") {
      pty.killSession(proc.id)
    }
    onRemove(proc.id)
  }, [pty, onRemove])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    dragRef.current = { startY: e.clientY, startH: height }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [height])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return
    // Dragging up = smaller clientY = larger panel
    const delta = dragRef.current.startY - e.clientY
    const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, dragRef.current.startH + delta))
    setHeight(next)
  }, [])

  const onPointerUp = useCallback(() => {
    if (!dragRef.current) return
    dragRef.current = null
    try { localStorage.setItem(HEIGHT_KEY, String(height)) } catch { /* ignore */ }
  }, [height])

  const activeProcess = activeProcessId ? processes.get(activeProcessId) : null
  const processList = [...processes.values()]

  return (
    <Tabs
      value={activeProcessId}
      onValueChange={(value) => {
        if (typeof value === "string") onSetActive(value)
      }}
      className="shrink-0 gap-0 border-t bg-background"
    >
      {!mobile && !collapsed && activeProcess && (
        <div
          className="h-1 cursor-row-resize transition-colors hover:bg-accent active:bg-muted-foreground/30"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      )}

      <div className={cn(
        "flex shrink-0 items-center border-b bg-card",
        mobile ? "h-7 gap-1 px-2" : "h-8 gap-2 px-3",
      )}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          onClick={onToggleCollapse}
          aria-label={collapsed ? "Expand terminal panel" : "Collapse terminal panel"}
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <ChevronRight data-icon="inline-start" />
          ) : (
            <ChevronDown data-icon="inline-start" />
          )}
          <span className={cn(mobile && "sr-only")}>Terminal</span>
        </Button>

        <TabsList
          variant="default"
          aria-label="Open processes"
          className={cn(
            "min-w-0 flex-1 justify-start overflow-x-auto no-scrollbar",
            !mobile && "ml-2",
          )}
        >
          {processList.map((proc) => (
            <ProcessTab
              key={proc.id}
              process={proc}
              isActive={proc.id === activeProcessId}
              onSelectActive={() => onSetActive(proc.id)}
              onClose={() => handleClose(proc)}
              mobile={mobile}
            />
          ))}
        </TabsList>

        {onRequestTerminal && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!projectDir}
            onClick={onRequestTerminal}
            aria-label="New terminal"
            title={projectDir ? "New terminal" : "Open a project to start a terminal"}
          >
            <Plus />
          </Button>
        )}
      </div>

      <div
        className={cn("min-h-0", collapsed ? "hidden" : "flex")}
        style={{ height: mobile ? "min(36dvh, 260px)" : height }}
      >
        {!collapsed && !mobile && (
          <ProcessPanelScripts
            projectDir={projectDir}
            onProcessStarted={onProcessStarted}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          {processList.map((process) => (
            <TabsContent
              key={process.id}
              value={process.id}
              className="flex min-h-0 flex-1 flex-col"
            >
              {!collapsed && process.type === "task" && (
                <ProcessOutput process={process} />
              )}

              {!collapsed && process.type !== "task" && (
                <Suspense
                  fallback={(
                    <div className="flex size-full items-center justify-center text-xs text-muted-foreground">
                      Loading terminal…
                    </div>
                  )}
                >
                  <TerminalOutput
                    processId={process.id}
                    autoFocus
                    onRequestNew={onRequestTerminal}
                    onRequestClose={() => handleClose(process)}
                    onAddContext={onAddTerminalContext}
                  />
                </Suspense>
              )}
            </TabsContent>
          ))}

          {!collapsed && !activeProcess && (
            <Empty className="rounded-none">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <TerminalSquare />
                </EmptyMedia>
                <EmptyTitle>No terminal open</EmptyTitle>
                <EmptyDescription>
                  Start a terminal here or run a project script from the left.
                </EmptyDescription>
              </EmptyHeader>
              {onRequestTerminal && projectDir && (
                <EmptyContent>
                  <Button type="button" size="sm" onClick={onRequestTerminal}>
                    <Plus data-icon="inline-start" />
                    New terminal
                  </Button>
                </EmptyContent>
              )}
            </Empty>
          )}
        </div>
      </div>
    </Tabs>
  )
})
