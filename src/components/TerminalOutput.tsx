import { useEffect, useRef, useCallback, useState } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Quote } from "lucide-react"
import { Button } from "@/components/ui/button"
import { usePty } from "@/contexts/PtyContext"
import { matchesKeybinding } from "@/lib/keybindings"
import "@xterm/xterm/css/xterm.css"

// ── Theme — hardcoded hex values matching dark theme CSS variables ────────────

const TERMINAL_THEME = {
  background: "#1a1a2e",
  foreground: "#f5f5f5",
  cursor: "#f5f5f5",
  cursorAccent: "#1a1a2e",
  selectionBackground: "rgba(255,255,255,0.15)",
  black: "#1a1a2e",
  red: "#ff5555",
  green: "#50fa7b",
  yellow: "#f1fa8c",
  blue: "#6272a4",
  magenta: "#ff79c6",
  cyan: "#8be9fd",
  white: "#f8f8f2",
  brightBlack: "#6272a4",
  brightRed: "#ff6e6e",
  brightGreen: "#69ff94",
  brightYellow: "#ffffa5",
  brightBlue: "#d6acff",
  brightMagenta: "#ff92df",
  brightCyan: "#a4ffff",
  brightWhite: "#ffffff",
}

export function TerminalOutput({ processId, autoFocus = false, onRequestNew, onRequestClose, onAddContext }: {
  processId: string
  autoFocus?: boolean
  onRequestNew?: () => void
  onRequestClose?: () => void
  onAddContext?: (text: string) => void
}) {
  const pty = usePty()

  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const rafRef = useRef<number | null>(null)
  const shortcutCallbacksRef = useRef({ onRequestNew, onRequestClose })
  const [selectedText, setSelectedText] = useState("")

  useEffect(() => {
    shortcutCallbacksRef.current = { onRequestNew, onRequestClose }
  }, [onRequestClose, onRequestNew])

  const scheduleFit = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const fit = fitRef.current
      const term = termRef.current
      if (!fit || !term) return
      try {
        fit.fit()
        pty.resize(processId, term.cols, term.rows)
      } catch {
        // fitAddon.fit() can throw if the terminal is not yet visible
      }
    })
  }, [processId, pty])

  const handleMessage = useCallback(
    (type: string, data: unknown) => {
      const term = termRef.current
      if (!term) return

      if (type === "output") {
        const msg = data as { data?: string }
        if (msg.data) {
          term.write(msg.data)
        }
      } else if (type === "exit") {
        const msg = data as { code?: number | null }
        const code = msg.code ?? 0
        term.write(`\r\n\x1b[2m[Process exited with code ${code}]\x1b[0m\r\n`)
      }
    },
    []
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const terminal = new Terminal({
      theme: TERMINAL_THEME,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 5000,
      allowTransparency: true,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()

    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.open(container)
    terminal.attachCustomKeyEventHandler((event) => {
      if (matchesKeybinding("newIntegratedTerminal", event)) {
        if (event.type === "keydown") shortcutCallbacksRef.current.onRequestNew?.()
        return false
      }
      if (matchesKeybinding("closeIntegratedTerminal", event)) {
        if (event.type === "keydown") shortcutCallbacksRef.current.onRequestClose?.()
        return false
      }
      return true
    })

    termRef.current = terminal
    fitRef.current = fitAddon

    try {
      fitAddon.fit()
      pty.resize(processId, terminal.cols, terminal.rows)
    } catch {
      // fitAddon.fit() can throw if not yet visible
    }

    pty.subscribe(processId, handleMessage)
    pty.send({ type: "attach", id: processId })

    if (autoFocus) {
      requestAnimationFrame(() => terminal.focus())
    }

    const dataDisposable = terminal.onData((data: string) => {
      pty.writeInput(processId, data)
    })
    const selectionDisposable = terminal.onSelectionChange(() => {
      setSelectedText(terminal.getSelection())
    })

    const resizeObserver = new ResizeObserver(scheduleFit)
    resizeObserver.observe(container)

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      resizeObserver.disconnect()
      dataDisposable.dispose()
      selectionDisposable.dispose()
      pty.unsubscribe(processId)
      terminal.dispose()
      termRef.current = null
      fitRef.current = null
      rafRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processId])

  const handleClick = useCallback(() => {
    termRef.current?.focus()
  }, [])

  return (
    <div className="relative size-full bg-[#1a1a2e]">
      <div
        ref={containerRef}
        className="size-full p-1"
        role="region"
        aria-label="Terminal output"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") handleClick()
        }}
      />
      {selectedText && onAddContext && (
        <Button
          variant="secondary"
          size="sm"
          className="absolute right-3 top-3"
          onClick={() => {
            onAddContext(selectedText)
            termRef.current?.clearSelection()
            setSelectedText("")
          }}
        >
          <Quote data-icon="inline-start" />
          Add to prompt
        </Button>
      )}
    </div>
  )
}
