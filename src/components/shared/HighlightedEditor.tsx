import { useState, useEffect, useCallback, useRef, type RefObject } from "react"
import { cn } from "@/lib/utils"
import { highlightCode, getLangFromPath, type ThemedToken } from "@/lib/shiki"
import { useIsDarkMode } from "@/hooks/useIsDarkMode"

/**
 * Tokenizing runs on every (debounced) keystroke, so past this size the cost
 * outweighs the benefit and the editor falls back to plain monospace text.
 */
const MAX_HIGHLIGHT_CHARS = 200_000

interface HighlightedEditorProps {
  value: string
  onChange: (v: string) => void
  readOnly: boolean
  filePath: string
  ariaLabel?: string
  textareaRef?: RefObject<HTMLTextAreaElement | null>
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onSelect?: (event: React.SyntheticEvent<HTMLTextAreaElement>) => void
}

export function HighlightedEditor({
  value,
  onChange,
  readOnly,
  filePath,
  ariaLabel,
  textareaRef,
  onKeyDown,
  onSelect,
}: HighlightedEditorProps) {
  const isDark = useIsDarkMode()
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null)
  const innerRef = useRef<HTMLTextAreaElement>(null)
  const preRef = useRef<HTMLPreElement>(null)

  const lang = getLangFromPath(filePath) ?? "markdown"
  const tooLargeToHighlight = value.length > MAX_HIGHLIGHT_CHARS

  // Highlight with debounce
  useEffect(() => {
    if (tooLargeToHighlight) {
      setTokens(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      highlightCode(value, lang, isDark).then((result) => {
        if (!cancelled) setTokens(result)
      })
    }, 80)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [value, lang, isDark, tooLargeToHighlight])

  // Sync scroll between textarea and highlighted pre
  const handleScroll = useCallback(() => {
    if (innerRef.current && preRef.current) {
      preRef.current.scrollTop = innerRef.current.scrollTop
      preRef.current.scrollLeft = innerRef.current.scrollLeft
    }
  }, [])

  const attachTextarea = useCallback((node: HTMLTextAreaElement | null) => {
    innerRef.current = node
    if (textareaRef) textareaRef.current = node
  }, [textareaRef])

  return (
    <div className="relative min-h-0 flex-1 bg-background">
      {/* Highlighted layer (behind) */}
      <pre
        ref={preRef}
        aria-hidden
        className={cn(
          "absolute inset-0 overflow-hidden font-mono text-[13px] leading-relaxed p-4 m-0 pointer-events-none whitespace-pre-wrap break-words",
          readOnly && "opacity-70",
        )}
      >
        {tokens ? (
          tokens.map((line, i) => (
            <span key={i}>
              {line.map((token, j) => (
                <span key={j} style={{ color: token.color }}>{token.content}</span>
              ))}
              {"\n"}
            </span>
          ))
        ) : (
          <code className="text-foreground">{value}</code>
        )}
      </pre>

      {/* Editable textarea (on top, transparent text) */}
      <textarea
        ref={attachTextarea}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={handleScroll}
        onKeyDown={onKeyDown}
        onSelect={onSelect}
        readOnly={readOnly}
        spellCheck={false}
        className={cn(
          "absolute inset-0 w-full h-full resize-none bg-transparent font-mono text-[13px] leading-relaxed p-4 outline-none",
          "text-transparent caret-foreground selection:bg-info/30",
          "scrollbar-thin scrollbar-track-transparent scrollbar-thumb-border",
          readOnly && "cursor-default",
        )}
        placeholder="Empty file"
      />
    </div>
  )
}
