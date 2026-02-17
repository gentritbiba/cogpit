import { useState, useEffect, useRef } from "react"
import { X, Terminal } from "lucide-react"
import { Button } from "@/components/ui/button"

interface TerminalPanelProps {
  outputPath: string
  title?: string
  onClose: () => void
}

// Light ANSI stripping - keep printable text, remove control sequences
// eslint-disable-next-line no-control-regex
const ANSI_OSC = /\x1b\].*?(?:\x07|\x1b\\)/g
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1b\[[0-9;]*[A-Za-z]/g
// eslint-disable-next-line no-control-regex
const ANSI_OTHER = /\x1b[()][AB012]/g
// Spinner/progress line redraws: [2K = erase line, [1G = cursor to col 1
const LINE_REDRAW = /\[2K\[1G/g

function stripAnsi(text: string): string {
  return text
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(ANSI_OTHER, "")
    .replace(LINE_REDRAW, "\n")
    .replace(/\r/g, "")
}

export function TerminalPanel({
  outputPath,
  title,
  onClose,
}: TerminalPanelProps) {
  const [output, setOutput] = useState("")
  const [connected, setConnected] = useState(false)
  const outputRef = useRef<HTMLPreElement>(null)

  // Stream output from the task-output SSE endpoint
  useEffect(() => {
    if (!outputPath) return

    const es = new EventSource(
      `/api/task-output?path=${encodeURIComponent(outputPath)}`
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
    <div className="flex shrink-0 flex-col border-t border-zinc-700 bg-zinc-950">
      {/* Header */}
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3">
        <div className="flex items-center gap-2 text-[11px] text-zinc-400">
          <Terminal className="size-3" />
          <span className="font-medium">{title || "Server Output"}</span>
          {connected && (
            <span className="flex items-center gap-1 text-green-500">
              <span className="inline-block size-1.5 rounded-full bg-green-500" />
              live
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 w-5 p-0 text-zinc-500 hover:text-zinc-200"
          onClick={onClose}
        >
          <X className="size-3" />
        </Button>
      </div>

      {/* Output */}
      <pre
        ref={outputRef}
        className="flex-1 overflow-auto bg-zinc-950 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-300 min-h-[150px] max-h-[300px] whitespace-pre-wrap break-words"
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
