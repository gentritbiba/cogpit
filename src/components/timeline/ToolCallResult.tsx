import { useEffect, useMemo, useState } from "react"
import { useIsDarkMode } from "@/hooks/useIsDarkMode"
import { getLangFromPath, highlightCode } from "@/lib/shiki"

type TokenLine = Array<{ content: string; color?: string }>

const CODE_BLOCK_CLASS =
  "text-[11px] font-mono whitespace-pre-wrap break-all rounded p-2 max-h-96 overflow-y-auto border text-muted-foreground bg-elevation-0 border-border/30 leading-[1.6]"

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
}: {
  lines: string[]
  tokens: TokenLine[] | null
  lineNums?: string[]
}): React.ReactElement {
  return (
    <pre className={CODE_BLOCK_CLASS}>
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

function parseReadResult(text: string): { lineNums: string[]; codeLines: string[] } {
  const lineNums: string[] = []
  const codeLines: string[] = []
  for (const line of text.split("\n")) {
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
}: {
  result: string
  filePath: string
  expanded: boolean
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

  return <HighlightedCodeBlock lines={codeLines} tokens={tokens} lineNums={lineNums} />
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
}: {
  result: string
  expanded: boolean
  alreadyPretty?: boolean
}): React.ReactElement {
  const isDark = useIsDarkMode()
  const pretty = useMemo(
    () => alreadyPretty ? result : (tryPrettyJson(result) ?? result),
    [result, alreadyPretty],
  )
  const sliced = expanded ? pretty : pretty.slice(0, 2000)
  const lines = useMemo(() => sliced.split("\n"), [sliced])
  const tokens = useHighlightedTokens(sliced, "json", isDark)

  return <HighlightedCodeBlock lines={lines} tokens={tokens} />
}
