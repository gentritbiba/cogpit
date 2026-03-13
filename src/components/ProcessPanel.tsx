import { useState, useEffect, useRef, useCallback, memo } from "react"
import { authUrl } from "@/lib/auth"
import { ChevronDown, ChevronRight, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ProcessEntry } from "@/hooks/useProcessPanel"
import { TerminalOutput } from "@/components/TerminalOutput"
import { usePty } from "@/contexts/PtyContext"

// ── ANSI stripping ───────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_OSC = /\x1b\].*?(?:\x07|\x1b\\)/g
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1b\[[0-9;]*[A-Za-z]/g
// eslint-disable-next-line no-control-regex
const ANSI_OTHER = /\x1b[()][AB012]/g
const LINE_REDRAW = /\[2K\[1G/g

function stripAnsi(text: string): string {
  return text
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(ANSI_OTHER, "")
    .replace(LINE_REDRAW, "\n")
    .replace(/\r/g, "")
}

// ── Type badge colors ────────────────────────────────────────────────────────

const TYPE_STYLES: Record<ProcessEntry["type"], string> = {
  script: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  task: "bg-green-500/15 text-green-400 border-green-500/30",
  terminal: "bg-purple-500/15 text-purple-400 border-purple-500/30",
}

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
      className="flex-1 overflow-auto bg-elevation-0 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap break-words"
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
  onClick,
  onClose,
}: {
  process: ProcessEntry
  isActive: boolean
  onClick: () => void
  onClose: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={process.source ?? process.name}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-medium transition-colors shrink-0",
        isActive
          ? "bg-elevation-2 text-foreground border border-border"
          : "text-muted-foreground hover:text-foreground hover:bg-elevation-2 border border-transparent"
      )}
    >
      {process.status === "running" && (
        <span className="inline-block size-1.5 rounded-full bg-green-400 shrink-0" />
      )}
      {process.status === "errored" && (
        <span className="inline-block size-1.5 rounded-full bg-red-400 shrink-0" />
      )}

      <span className="truncate max-w-[100px]">{process.name}</span>

      <span className={cn(
        "inline-flex items-center rounded px-1 py-px text-[9px] border",
        TYPE_STYLES[process.type]
      )}>
        {process.type}
      </span>

      <span
        role="button"
        onClick={(e) => { e.stopPropagation(); onClose() }}
        className="ml-0.5 rounded p-0.5 hover:bg-elevation-3 text-muted-foreground hover:text-foreground"
      >
        <X className="size-2.5" />
      </span>
    </button>
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
  onUpdateStatus?: (id: string, status: ProcessEntry["status"]) => void
}

export const ProcessPanel = memo(function ProcessPanel({
  processes,
  activeProcessId,
  collapsed,
  onSetActive,
  onRemove,
  onToggleCollapse,
  onUpdateStatus,
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
    setHeight((h) => {
      try { localStorage.setItem(HEIGHT_KEY, String(h)) } catch { /* ignore */ }
      return h
    })
  }, [])

  if (processes.size === 0) return null

  const activeProcess = activeProcessId ? processes.get(activeProcessId) : null
  const processList = [...processes.values()]

  return (
    <div className="flex shrink-0 flex-col border-t border-border/70 bg-elevation-0">
      {!collapsed && activeProcess && (
        <div
          className="h-1 cursor-row-resize hover:bg-blue-500/30 active:bg-blue-500/50 transition-colors"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      )}

      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-elevation-1 px-3">
        <button
          className="flex items-center gap-1.5 hover:text-foreground transition-colors"
          onClick={onToggleCollapse}
          aria-label={collapsed ? "Expand process panel" : "Collapse process panel"}
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <ChevronRight className="size-3 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3 text-muted-foreground" />
          )}
          <span className="text-[11px] font-medium text-muted-foreground">Processes</span>
        </button>

        <div className="flex-1 flex items-center gap-1 overflow-x-auto no-scrollbar ml-2">
          {processList.map((proc) => (
            <ProcessTab
              key={proc.id}
              process={proc}
              isActive={proc.id === activeProcessId}
              onClick={() => onSetActive(proc.id)}
              onClose={() => handleClose(proc)}
            />
          ))}
        </div>
      </div>

      {!collapsed && activeProcess && (
        <div className="flex flex-col" style={{ height }}>
          {activeProcess.type === "task" ? (
            <ProcessOutput
              key={activeProcess.id}
              process={activeProcess}
            />
          ) : (
            <TerminalOutput
              key={activeProcess.id}
              processId={activeProcess.id}
              autoFocus
            />
          )}
        </div>
      )}
    </div>
  )
})
