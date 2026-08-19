import { useState, useEffect, useRef, type HTMLAttributes } from "react"
import { Check, Copy, ChevronDown, ChevronRight } from "lucide-react"
import { highlightCode } from "@/lib/shiki"
import { useIsDarkMode } from "@/hooks/useIsDarkMode"
import { cn, copyToClipboard } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

// ── Language display name mapping ───────────────────────────────────────────

const LANG_DISPLAY: Record<string, string> = {
  js: "JavaScript", jsx: "JSX", ts: "TypeScript", tsx: "TSX",
  py: "Python", rb: "Ruby", rs: "Rust", go: "Go",
  java: "Java", kt: "Kotlin", swift: "Swift", cs: "C#",
  cpp: "C++", c: "C", sh: "Shell", bash: "Bash", zsh: "Zsh",
  fish: "Fish", ps1: "PowerShell", powershell: "PowerShell",
  sql: "SQL", graphql: "GraphQL", html: "HTML", css: "CSS",
  scss: "SCSS", less: "LESS", json: "JSON", yaml: "YAML",
  yml: "YAML", toml: "TOML", xml: "XML", md: "Markdown",
  markdown: "Markdown", dockerfile: "Dockerfile", docker: "Docker",
  makefile: "Makefile", cmake: "CMake", lua: "Lua", vim: "Vim",
  diff: "Diff", plaintext: "Text", text: "Text", txt: "Text",
  php: "PHP", perl: "Perl", r: "R", scala: "Scala",
  elixir: "Elixir", clojure: "Clojure", haskell: "Haskell",
  ocaml: "OCaml", zig: "Zig", nim: "Nim", dart: "Dart",
  vue: "Vue", svelte: "Svelte", astro: "Astro", prisma: "Prisma",
  terraform: "Terraform", tf: "Terraform", proto: "Protobuf",
  protobuf: "Protobuf",
}

function getLangDisplay(lang: string): string {
  return LANG_DISPLAY[lang.toLowerCase()] ?? lang
}

// ── Parse language from className ───────────────────────────────────────────

function parseLang(className: string | undefined): string | null {
  if (!className) return null
  const match = className.match(/language-(\S+)/)
  return match?.[1] ?? null
}

// ── Copy button ─────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null)
  const copyRequestRef = useRef(0)

  useEffect(() => {
    return () => {
      copyRequestRef.current += 1
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  function handleCopy() {
    const requestId = ++copyRequestRef.current
    copyToClipboard(text).then((ok) => {
      if (ok && requestId === copyRequestRef.current) {
        if (timerRef.current) clearTimeout(timerRef.current)
        setCopied(true)
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          setCopied(false)
        }, 2000)
      }
    })
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={handleCopy}
      className="text-muted-foreground"
      title="Copy code"
      aria-label={copied ? "Copied" : "Copy code"}
    >
      {copied ? (
        <>
          <Check className="text-success" data-icon="inline-start" />
          <span className="text-success">Copied</span>
        </>
      ) : (
        <Copy data-icon="icon" />
      )}
    </Button>
  )
}

// ── Line number gutter (shared between highlighted and plain rendering) ──

function LineNumber({ num }: { num: number }): React.ReactElement {
  return (
    <span className="mr-3 inline-block w-8 select-none text-right text-xs text-muted-foreground/60">
      {num}
    </span>
  )
}

// ── MarkdownCodeBlock component ─────────────────────────────────────────────

type CodeProps = HTMLAttributes<HTMLElement> & {
  children?: React.ReactNode
  className?: string
  node?: unknown
}

export function MarkdownCodeBlock({ children, className, node: _node, ...rest }: CodeProps): React.ReactElement {
  const isInline = !className && typeof children === "string" && !children.includes("\n")
  const lang = parseLang(className)
  const code = String(children).replace(/\n$/, "")

  if (isInline) {
    return (
      <code
        className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.9em] text-foreground"
        {...rest}
      >
        {children}
      </code>
    )
  }

  return <HighlightedCodeBlock code={code} lang={lang} {...rest} />
}

// ── Highlighted code block with Shiki ───────────────────────────────────────

type TokenLine = Array<{ content: string; color?: string }>

interface HighlightedTokens {
  key: string
  lines: TokenLine[] | null
}

function HighlightedCodeBlock({
  code,
  lang,
  ...rest
}: {
  code: string
  lang: string | null
} & Omit<HTMLAttributes<HTMLElement>, "lang">): React.ReactElement {
  const isDark = useIsDarkMode()
  const [highlighted, setHighlighted] = useState<HighlightedTokens | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const lines = code.split("\n")
  const lineCount = lines.length
  const isLong = lineCount > 30
  const highlightKey = lang ? `${lang}\u0000${isDark ? "dark" : "light"}\u0000${code}` : null
  const tokens = highlighted?.key === highlightKey ? highlighted.lines : null

  useEffect(() => {
    if (!lang || !highlightKey) return
    let cancelled = false
    highlightCode(code, lang, isDark).then((result) => {
      if (!cancelled) setHighlighted({ key: highlightKey, lines: result })
    })
    return () => {
      cancelled = true
    }
  }, [code, lang, isDark, highlightKey])

  const Chevron = collapsed ? ChevronRight : ChevronDown

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border bg-muted/20">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-1.5">
        <div className="flex items-center gap-2">
          {isLong && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => setCollapsed(!collapsed)}
              className="text-muted-foreground"
              aria-label={collapsed ? "Expand code" : "Collapse code"}
            >
              <Chevron data-icon="icon" />
            </Button>
          )}
          {lang && (
            <Badge variant="ghost" className="px-0 uppercase tracking-wide text-muted-foreground">
              {getLangDisplay(lang)}
            </Badge>
          )}
          {isLong && (
            <span className="text-xs text-muted-foreground">
              {lineCount} lines
            </span>
          )}
        </div>
        <CopyButton text={code} />
      </div>

      {!collapsed && (
        <div className="overflow-x-auto">
          <pre className="m-0 p-3 font-mono text-xs leading-relaxed">
            <code className={cn("block", !tokens && "text-foreground/90")} {...rest}>
              {lines.map((line, i) => {
                const tokenLine = tokens?.[i]
                return (
                  <span key={i} className="block">
                    <LineNumber num={i + 1} />
                    {tokenLine
                      ? tokenLine.map((token, j) => (
                          <span key={j} style={{ color: token.color }}>
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
        </div>
      )}

      {collapsed && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setCollapsed(false)}
          className="h-auto w-full justify-start rounded-none px-3 py-2 text-xs text-muted-foreground"
          aria-label={`Expand ${lineCount} lines of code`}
        >
          Show {lineCount} lines...
        </Button>
      )}
    </div>
  )
}
