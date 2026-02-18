import { useState, useEffect, useRef, Fragment, memo } from "react"
import { authUrl } from "@/lib/auth"
import { ChevronDown, ChevronRight } from "lucide-react"
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable"
import { cn } from "@/lib/utils"

// ── ANSI stripping (extracted from TerminalPanel) ────────────────────────

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

// ── ServerOutput — SSE streaming display for a single server ─────────────

function ServerOutput({ outputPath, title }: { outputPath: string; title: string }) {
  const [output, setOutput] = useState("")
  const [connected, setConnected] = useState(false)
  const outputRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (!outputPath) return

    const es = new EventSource(
      authUrl(`/api/task-output?path=${encodeURIComponent(outputPath)}`)
    )

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
  }, [outputPath])

  // Auto-scroll
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [output])

  return (
    <div className="flex h-full flex-col min-w-0">
      {/* Mini header: server title + connection status */}
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-zinc-800 bg-zinc-900/50 px-2 text-[10px]">
        <span
          className={cn(
            "inline-block size-1.5 rounded-full shrink-0",
            connected ? "bg-green-500" : "bg-zinc-600"
          )}
        />
        <span className="truncate font-medium text-zinc-400">{title}</span>
      </div>
      {/* Scrollable output */}
      <pre
        ref={outputRef}
        className="flex-1 overflow-auto bg-zinc-950 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-zinc-300 whitespace-pre-wrap break-words"
      >
        {output || (
          <span className="text-zinc-600">
            {connected ? "Waiting for output..." : "Connecting..."}
          </span>
        )}
      </pre>
    </div>
  )
}

// ── ServerPanel — collapsible bottom panel with server badges + split view ──

export interface ServerInfo {
  outputPath: string
  title: string
}

interface ServerPanelProps {
  servers: Map<string, ServerInfo>
  visibleIds: Set<string>
  collapsed: boolean
  onToggleServer: (id: string) => void
  onToggleCollapse: () => void
}

export const ServerPanel = memo(function ServerPanel({
  servers,
  visibleIds,
  collapsed,
  onToggleServer,
  onToggleCollapse,
}: ServerPanelProps) {
  if (servers.size === 0) return null

  const visibleServers = [...servers.entries()].filter(([id]) => visibleIds.has(id))
  // Key forces ResizablePanelGroup remount when visible set changes
  const panelKey = visibleServers.map(([id]) => id).join(",")

  return (
    <div className="flex shrink-0 flex-col border-t border-zinc-700 bg-zinc-950">
      {/* Header — always visible */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3">
        <button
          className="flex items-center gap-1.5 hover:text-zinc-300 transition-colors"
          onClick={onToggleCollapse}
          aria-label={collapsed ? "Expand server panel" : "Collapse server panel"}
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <ChevronRight className="size-3 text-zinc-500" />
          ) : (
            <ChevronDown className="size-3 text-zinc-500" />
          )}
          <span className="text-[11px] font-medium text-zinc-400">Servers</span>
        </button>

        <div className="flex-1" />

        {/* Server badges */}
        <div className="flex items-center gap-1">
          {[...servers.entries()].map(([id, info]) => {
            const isVisible = visibleIds.has(id)
            return (
              <button
                key={id}
                onClick={() => onToggleServer(id)}
                aria-label={`${isVisible ? "Hide" : "Show"} ${info.title}`}
                aria-pressed={isVisible}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-all",
                  isVisible
                    ? "bg-green-500/15 text-green-400 border border-green-500/30"
                    : "bg-zinc-800 text-zinc-500 border border-zinc-700 hover:border-zinc-600 hover:text-zinc-400"
                )}
              >
                <span
                  className={cn(
                    "inline-block size-1.5 rounded-full",
                    isVisible ? "bg-green-400" : "bg-zinc-600"
                  )}
                />
                <span className="truncate max-w-[80px]">{info.title}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Body — shown when expanded and at least one server is visible */}
      {!collapsed && visibleServers.length > 0 && (
        <div className="h-[200px]">
          {visibleServers.length === 1 ? (
            <ServerOutput
              key={visibleServers[0][0]}
              outputPath={visibleServers[0][1].outputPath}
              title={visibleServers[0][1].title}
            />
          ) : (
            <ResizablePanelGroup key={panelKey} orientation="horizontal">
              {visibleServers.map(([id, info], i) => (
                <Fragment key={id}>
                  {i > 0 && <ResizableHandle />}
                  <ResizablePanel
                    defaultSize={Math.floor(100 / visibleServers.length)}
                  >
                    <ServerOutput outputPath={info.outputPath} title={info.title} />
                  </ResizablePanel>
                </Fragment>
              ))}
            </ResizablePanelGroup>
          )}
        </div>
      )}
    </div>
  )
})
