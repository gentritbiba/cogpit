import { useEffect, useId, useMemo, useState } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback"
import { cn } from "@/lib/utils"
import { useIsDarkMode } from "@/hooks/useIsDarkMode"
import { getLangFromPath, highlightCode } from "@/lib/shiki"

type TokenLine = Array<{ content: string; color?: string }>

export type ToolResultVariant = "boxed" | "unboxed"

const BOXED_CODE_BLOCK_CLASS =
  "min-w-0 max-h-96 overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-md border bg-muted/30 p-2 font-mono text-xs leading-relaxed text-muted-foreground"
export const TOOL_RESULT_CLASS =
  "min-w-0 max-h-96 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] border-l border-border pl-3 font-mono text-xs leading-relaxed text-muted-foreground"

function useHighlightedTokens(
  code: string,
  lang: string | null,
  isDark: boolean,
): TokenLine[] | null {
  const [highlighted, setHighlighted] = useState<{
    code: string
    lang: string
    isDark: boolean
    tokens: TokenLine[] | null
  } | null>(null)

  useEffect(() => {
    if (!lang) return
    let cancelled = false
    void highlightCode(code, lang, isDark).then((tokens) => {
      if (!cancelled) setHighlighted({ code, lang, isDark, tokens })
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [code, lang, isDark])

  return highlighted?.code === code && highlighted.lang === lang && highlighted.isDark === isDark
    ? highlighted.tokens
    : null
}

function HighlightedCodeBlock({
  lines,
  tokens,
  lineNums,
  variant,
  label,
}: {
  lines: string[]
  tokens: TokenLine[] | null
  lineNums?: string[]
  variant: ToolResultVariant
  label?: string
}): React.ReactElement {
  return (
    <pre tabIndex={0} className={variant === "boxed" ? BOXED_CODE_BLOCK_CLASS : TOOL_RESULT_CLASS}>
      <code className="block" aria-label={label}>
        {lines.map((line, lineIndex) => {
          const tokenLine = tokens?.[lineIndex]
          return (
            <span key={lineIndex} className="block">
              {lineNums?.[lineIndex] && (
                <span className="inline-block w-10 text-right mr-2 text-muted-foreground/30 select-none">
                  {lineNums[lineIndex]}
                </span>
              )}
              {tokenLine
                ? tokenLine.map((token, tokenIndex) => (
                    <span key={tokenIndex} style={{ color: token.color }}>
                      {token.content}
                    </span>
                  ))
                : line || "\u00A0"
              }
            </span>
          )
        })}
      </code>
    </pre>
  )
}

export function ToolCodeHighlighted({ code, language, label }: { code: string; language: string; label: string }): React.ReactElement {
  const isDark = useIsDarkMode()
  const tokens = useHighlightedTokens(code, language, isDark)
  const lines = useMemo(() => splitLogicalLines(code), [code])
  return <HighlightedCodeBlock lines={lines} tokens={tokens} variant="unboxed" label={label} />
}

const LINE_PREFIX_RE = /^(\s*\d+)→(.*)$/

function splitLogicalLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

function parseReadResult(text: string): { lineNums: string[]; codeLines: string[] } {
  const lineNums: string[] = []
  const codeLines: string[] = []
  for (const line of splitLogicalLines(text)) {
    const match = line.match(LINE_PREFIX_RE)
    if (match) {
      lineNums.push(match[1])
      codeLines.push(match[2])
    } else {
      lineNums.push("")
      codeLines.push(line)
    }
  }
  return { lineNums, codeLines }
}

export function ReadResultHighlighted({
  result,
  filePath,
  expanded,
  variant = "boxed",
}: {
  result: string
  filePath: string
  expanded: boolean
  variant?: ToolResultVariant
}): React.ReactElement {
  const isDark = useIsDarkMode()
  const lang = getLangFromPath(filePath)
  const slicedResult = expanded ? result : previewToolResult(result).text
  const { lineNums, codeLines } = useMemo(
    () => parseReadResult(slicedResult),
    [slicedResult],
  )
  const code = useMemo(() => codeLines.join("\n"), [codeLines])
  const tokens = useHighlightedTokens(code, lang, isDark)

  return (
    <HighlightedCodeBlock
      lines={codeLines}
      tokens={tokens}
      lineNums={lineNums}
      variant={variant}
    />
  )
}

export function tryPrettyJson(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return null
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return null
  }
}

export function JsonResultHighlighted({
  result,
  expanded,
  alreadyPretty,
  variant = "boxed",
}: {
  result: string
  expanded: boolean
  alreadyPretty?: boolean
  variant?: ToolResultVariant
}): React.ReactElement {
  const isDark = useIsDarkMode()
  const pretty = useMemo(
    () => alreadyPretty ? result : (tryPrettyJson(result) ?? result),
    [result, alreadyPretty],
  )
  const sliced = expanded ? pretty : previewToolResult(pretty).text
  const lines = useMemo(() => splitLogicalLines(sliced), [sliced])
  const tokens = useHighlightedTokens(sliced, "json", isDark)

  return <HighlightedCodeBlock lines={lines} tokens={tokens} variant={variant} />
}


export function previewToolResult(result: string): { text: string; hiddenLines: number; truncated: boolean } {
  const lines = splitLogicalLines(result)
  const linePreview = lines.slice(0, 8).join("\n")
  const text = linePreview.slice(0, 1000)
  return {
    text,
    hiddenLines: Math.max(0, lines.length - splitLogicalLines(text).length),
    truncated: lines.length > 8 || linePreview.length > 1000,
  }
}

export function ToolResultPanel({
  result,
  isError = false,
  filePath,
}: {
  result: string
  isError?: boolean
  filePath?: string
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [copied, copyResult] = useCopyWithFeedback()
  const resultId = useId()
  const prettyJson = useMemo(
    () => !isError && !filePath ? tryPrettyJson(result) : null,
    [isError, filePath, result],
  )
  const formatted = prettyJson ?? result
  const preview = useMemo(() => previewToolResult(formatted), [formatted])
  const visible = expanded ? formatted : preview.text

  return (
    <section className="mt-1.5 min-w-0" aria-label="Result">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className={cn("text-xs text-muted-foreground", isError && "text-destructive")}>{isError ? "Error" : "Result"}</span>
        {result.trim() && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => copyResult(result)}
            aria-label={copied ? "Result copied" : "Copy result"}
          >
            {copied ? <Check data-icon="icon" /> : <Copy data-icon="icon" />}
          </Button>
        )}
      </div>
      <div id={resultId}>
        {!result.trim() ? (
          <p className="text-xs text-muted-foreground">No output</p>
        ) : filePath && !isError ? (
          <ReadResultHighlighted result={visible} filePath={filePath} expanded variant="unboxed" />
        ) : prettyJson !== null ? (
          <JsonResultHighlighted result={visible} expanded alreadyPretty variant="unboxed" />
        ) : (
          <pre tabIndex={0} className={cn(TOOL_RESULT_CLASS, isError && "border-destructive/30 text-destructive")}>
            {visible}
          </pre>
        )}
      </div>
      {preview.truncated && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="mt-1"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-controls={resultId}
        >
          {expanded ? "Show less" : preview.hiddenLines > 0 ? `+${preview.hiddenLines} ${preview.hiddenLines === 1 ? "line" : "lines"}` : "Show more"}
        </Button>
      )}
    </section>
  )
}
