import { useEffect, useMemo, useState } from "react"
import { useIsDarkMode } from "@/hooks/useIsDarkMode"
import { getLangFromPath, highlightCode } from "@/lib/shiki"

type TokenLine = Array<{ content: string; color?: string }>

export type ToolResultVariant = "boxed" | "unboxed"

const BOXED_CODE_BLOCK_CLASS =
  "max-h-96 overflow-y-auto whitespace-pre-wrap break-all rounded-md border bg-muted/30 p-2 font-mono text-xs leading-relaxed text-muted-foreground"
const DESKTOP_RESULT_CLASS =
  "whitespace-pre-wrap break-all border-l border-border pl-3 font-mono text-[11px] leading-relaxed text-muted-foreground"

function useHighlightedTokens(
  code: string,
  lang: string | null,
  isDark: boolean,
): TokenLine[] | null {
  const [tokens, setTokens] = useState<TokenLine[] | null>(null)

  useEffect(() => {
    if (!lang) {
      setTokens(null)
      return
    }
    let cancelled = false
    void highlightCode(code, lang, isDark).then((result) => {
      if (!cancelled) setTokens(result)
    })
    return () => { cancelled = true }
  }, [code, lang, isDark])

  return tokens
}

function HighlightedCodeBlock({
  lines,
  tokens,
  lineNums,
  variant,
}: {
  lines: string[]
  tokens: TokenLine[] | null
  lineNums?: string[]
  variant: ToolResultVariant
}): React.ReactElement {
  return (
    <pre className={variant === "boxed" ? BOXED_CODE_BLOCK_CLASS : DESKTOP_RESULT_CLASS}>
      <code className="block">
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
  const slicedResult = expanded ? result : result.slice(0, 500)
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
  const sliced = expanded ? pretty : pretty.slice(0, 2000)
  const lines = useMemo(() => splitLogicalLines(sliced), [sliced])
  const tokens = useHighlightedTokens(sliced, "json", isDark)

  return <HighlightedCodeBlock lines={lines} tokens={tokens} variant={variant} />
}
