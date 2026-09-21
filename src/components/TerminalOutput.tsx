import { useEffect, useRef, useCallback, useState } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Quote } from "lucide-react"
import { Button } from "@/components/ui/button"
import { usePty } from "@/contexts/PtyContext"
import { matchesKeybinding } from "@/lib/keybindings"
import { readTerminalTheme } from "@/lib/terminalTheme"

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
      theme: readTerminalTheme(container),
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
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = readTerminalTheme(container)
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] })
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
      themeObserver.disconnect()
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
    <div className="relative size-full bg-background">
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
