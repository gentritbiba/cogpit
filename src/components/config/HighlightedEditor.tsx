import { useState, useEffect, useCallback, useRef } from "react"
import type { ThemedToken } from "shiki"
import { cn } from "@/lib/utils"
import { highlightCode, getLangFromPath } from "@/lib/shiki"
import { useIsDarkMode } from "@/hooks/useIsDarkMode"

interface HighlightedEditorProps {
  value: string
  onChange: (v: string) => void
  readOnly: boolean
  filePath: string
}

export function HighlightedEditor({
  value,
  onChange,
  readOnly,
  filePath,
}: HighlightedEditorProps) {
  const isDark = useIsDarkMode()
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const preRef = useRef<HTMLPreElement>(null)

  const lang = getLangFromPath(filePath) ?? "markdown"

  // Highlight with debounce
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      highlightCode(value, lang, isDark).then((result) => {
        if (!cancelled) setTokens(result)
      })
    }, 80)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [value, lang, isDark])

  // Sync scroll between textarea and highlighted pre
  const handleScroll = useCallback(() => {
    if (textareaRef.current && preRef.current) {
      preRef.current.scrollTop = textareaRef.current.scrollTop
      preRef.current.scrollLeft = textareaRef.current.scrollLeft
    }
  }, [])

  return (
    <div className="relative flex-1 min-h-0 bg-elevation-0">
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
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={handleScroll}
        readOnly={readOnly}
        spellCheck={false}
        className={cn(
          "absolute inset-0 w-full h-full resize-none bg-transparent font-mono text-[13px] leading-relaxed p-4 outline-none",
          "text-transparent caret-foreground selection:bg-blue-500/30",
          "scrollbar-thin scrollbar-track-transparent scrollbar-thumb-border",
          readOnly && "cursor-default",
        )}
        placeholder="Empty file"
      />
    </div>
  )
}
