import { useId, useMemo, useState } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback"
import { cn } from "@/lib/utils"
import { useIsDarkMode } from "@/hooks/useIsDarkMode"
import { getLangFromPath } from "@/lib/shiki"
import { useHighlightedTokens } from "@/hooks/useHighlightedTokens"
import { useToolResultBody } from "@/hooks/useToolResultBody"
import { fetchFullBody } from "@/lib/toolResultBodies"
import type { ElidedResult } from "../../../shared/session/types"

export type TokenLine = Array<{ content: string; color?: string }>

export type ToolResultVariant = "boxed" | "unboxed"

const BOXED_CODE_BLOCK_CLASS =
  "min-w-0 max-h-96 overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-md border bg-muted p-3 font-mono text-xs leading-relaxed text-foreground/85"
export const TOOL_RESULT_CLASS =
  "min-w-0 max-h-96 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-md bg-muted p-3 font-mono text-xs leading-relaxed text-foreground/85"

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
                <span className="inline-block w-10 text-right mr-2 text-muted-foreground select-none">
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
  variant = "boxed",
}: {
  result: string
  filePath: string
  variant?: ToolResultVariant
}): React.ReactElement {
  const isDark = useIsDarkMode()
  const lang = getLangFromPath(filePath)
  const { lineNums, codeLines } = useMemo(() => parseReadResult(result), [result])
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
  alreadyPretty,
  variant = "boxed",
}: {
  result: string
  alreadyPretty?: boolean
  variant?: ToolResultVariant
}): React.ReactElement {
  const isDark = useIsDarkMode()
  const pretty = useMemo(
    () => alreadyPretty ? result : (tryPrettyJson(result) ?? result),
    [result, alreadyPretty],
  )
  const lines = useMemo(() => splitLogicalLines(pretty), [pretty])
  const tokens = useHighlightedTokens(pretty, "json", isDark)

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

export function formatResultSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function ToolResultPanel({
  result,
  resultRef,
  isError = false,
  filePath,
  renderResult,
}: {
  /** The result, or its preview while `resultRef` keeps the body on the server. */
  result: string
  resultRef?: ElidedResult
  isError?: boolean
  filePath?: string
  renderResult?: (visible: string) => React.ReactNode
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [copied, copyResult] = useCopyWithFeedback()
  const resultId = useId()
  // An elided body is fetched only while expanded, and the fetch is dropped on collapse.
  const body = useToolResultBody(resultRef, expanded)
  const text = body.status === "ready" ? body.text : result
  const prettyJson = useMemo(
    () => !isError && !filePath && (!resultRef || (body.status === "ready" && body.complete)) ? tryPrettyJson(text) : null,
    [isError, filePath, text, resultRef, body],
  )
  const formatted = prettyJson ?? text
  const preview = useMemo(() => previewToolResult(formatted), [formatted])
  const visible = expanded ? formatted : preview.text
  const truncated = preview.truncated || Boolean(resultRef)
  // A copy says when it holds less than the whole output, never passing a part off as all of it.
  const [copyNotice, setCopyNotice] = useState<string | null>(null)
  const copyFull = async () => {
    setCopyNotice(null)
    if (!resultRef) return copyResult(result)
    try {
      const full = await fetchFullBody(resultRef)
      copyResult(full.text)
      if (!full.complete) setCopyNotice(`Copied the first ${full.text.length.toLocaleString()} of ${full.total.toLocaleString()} characters: the output is too large to copy whole.`)
    } catch (error) {
      copyResult(text)
      setCopyNotice(`Copied the saved preview only. ${error instanceof Error ? error.message : "The full output could not be loaded."}`)
    }
  }

  return (
    <section className="mt-3 min-w-0" aria-label="Result">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className={cn("text-xs text-muted-foreground", isError && "text-destructive")}>{isError ? "Error" : "Result"}</span>
        {result.trim() && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => { void copyFull() }}
            aria-label={copied ? "Result copied" : "Copy result"}
          >
            {copied ? <Check data-icon="icon" /> : <Copy data-icon="icon" />}
          </Button>
        )}
      </div>
      <div id={resultId}>
        {!result.trim() ? (
          <p className="text-xs text-muted-foreground">No output</p>
        ) : renderResult ? renderResult(visible) : filePath && !isError ? (
          <ReadResultHighlighted result={visible} filePath={filePath} variant="unboxed" />
        ) : prettyJson !== null ? (
          <JsonResultHighlighted result={visible} alreadyPretty variant="unboxed" />
        ) : (
          <pre tabIndex={0} className={cn(TOOL_RESULT_CLASS, isError && "border-destructive/30 text-destructive")}>
            {visible}
          </pre>
        )}
      </div>
      {copyNotice && <p role="status" className="mt-1 text-xs text-warning">{copyNotice}</p>}
      {resultRef && expanded && <ElidedBodyStatus body={body} stub={resultRef} />}
      {truncated && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="mt-1"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-controls={resultId}
        >
          {expanded ? "Show less"
            : resultRef ? `Show full output (${resultRef.lines.toLocaleString()} ${resultRef.lines === 1 ? "line" : "lines"}, ${formatResultSize(resultRef.bytes)})`
            : preview.hiddenLines > 0 ? `+${preview.hiddenLines} ${preview.hiddenLines === 1 ? "line" : "lines"}` : "Show more"}
        </Button>
      )}
    </section>
  )
}

/** Where an expanded elided body is: loading, partly loaded, or unavailable and why. */
function ElidedBodyStatus({ body, stub }: { body: ReturnType<typeof useToolResultBody>; stub: ElidedResult }): React.ReactElement | null {
  if (body.status === "loading") return <p role="status" className="mt-1 text-xs text-muted-foreground">Loading full output ({formatResultSize(stub.bytes)})…</p>
  if (body.status === "unavailable") {
    return (
      <div role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Showing the saved preview. {body.message}</span>
        {(body.reason === "error") && <Button type="button" variant="ghost" size="xs" onClick={body.retry}>Retry</Button>}
      </div>
    )
  }
  if (body.status === "ready" && !body.complete) {
    return (
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground" role="status">
        <span>Showing {body.text.length.toLocaleString()} of {body.total.toLocaleString()} characters.</span>
        <Button type="button" variant="ghost" size="xs" onClick={body.loadMore} disabled={body.loadingMore}>{body.loadingMore ? "Loading…" : "Load more"}</Button>
      </div>
    )
  }
  return null
}
