import { useState, useEffect, useCallback, useRef, type HTMLAttributes } from "react"
import { Check, Copy, ChevronDown, ChevronRight } from "lucide-react"
import { highlightCode } from "@/lib/shiki"
import { useIsDarkMode } from "@/hooks/useIsDarkMode"
import { cn, copyToClipboard } from "@/lib/utils"

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
  return match ? match[1] : null
}

// ── Copy button ─────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const handleCopy = useCallback(() => {
    copyToClipboard(text).then((ok) => {
      if (ok) {
        setCopied(true)
        timerRef.current = setTimeout(() => setCopied(false), 2000)
      }
    })
  }, [text])

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-white/5"
      title="Copy code"
      aria-label={copied ? "Copied" : "Copy code"}
    >
      {copied ? (
        <>
          <Check className="w-3 h-3 text-green-400" />
          <span className="text-green-400">Copied</span>
        </>
      ) : (
        <Copy className="w-3 h-3" />
      )}
    </button>
  )
}

// ── Line number gutter (shared between highlighted and plain rendering) ──

function LineNumber({ num }: { num: number }): React.ReactElement {
  return (
    <span className="inline-block w-8 text-right mr-3 text-muted-foreground/30 select-none text-[11px]">
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
        className="text-[0.9em] font-mono px-1.5 py-0.5 rounded-md bg-elevation-2 text-orange-600 dark:text-orange-300 border border-border/30"
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

function HighlightedCodeBlock({
  code,
  lang,
  ...rest
}: {
  code: string
  lang: string | null
} & HTMLAttributes<HTMLElement>): React.ReactElement {
  const isDark = useIsDarkMode()
  const [tokens, setTokens] = useState<TokenLine[] | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const lines = code.split("\n")
  const lineCount = lines.length
  const isLong = lineCount > 30

  useEffect(() => {
    if (!lang) {
      setTokens(null)
      return
    }
    let cancelled = false
    highlightCode(code, lang, isDark).then((result) => {
      if (!cancelled) setTokens(result)
    })
    return () => {
      cancelled = true
    }
  }, [code, lang, isDark])

  const Chevron = collapsed ? ChevronRight : ChevronDown

  return (
    <div className="my-3 rounded-lg border border-border/50 bg-elevation-1 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-elevation-2/50 border-b border-border/30">
        <div className="flex items-center gap-2">
          {isLong && (
            <button
              onClick={() => setCollapsed(!collapsed)}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label={collapsed ? "Expand code" : "Collapse code"}
            >
              <Chevron className="w-3.5 h-3.5" />
            </button>
          )}
          {lang && (
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              {getLangDisplay(lang)}
            </span>
          )}
          {isLong && (
            <span className="text-[10px] text-muted-foreground/60">
              {lineCount} lines
            </span>
          )}
        </div>
        <CopyButton text={code} />
      </div>

      {!collapsed && (
        <div className="overflow-x-auto">
          <pre className="p-3 text-[12px] leading-[1.6] font-mono m-0">
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
        <button
          onClick={() => setCollapsed(false)}
          className="w-full px-3 py-2 text-[11px] text-muted-foreground hover:text-foreground hover:bg-elevation-2/30 transition-colors text-left"
          aria-label={`Expand ${lineCount} lines of code`}
        >
          Show {lineCount} lines...
        </button>
      )}
    </div>
  )
}
