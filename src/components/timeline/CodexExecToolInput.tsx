import { useEffect, useState } from "react"
import { Check, Clock3, Code2, Copy, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback"
import { useIsDarkMode } from "@/hooks/useIsDarkMode"
import { highlightCode } from "@/lib/shiki"
import { cn } from "@/lib/utils"

type TokenLine = Array<{ content: string; color?: string }>

interface InputMeta {
  key: string
  label: string
  value: string
  icon?: LucideIcon
}

function formatTimeout(value: number): string {
  if (value < 1000) return `${value} ms`
  if (value % 60_000 === 0) return `${value / 60_000} min`
  if (value % 1000 === 0) return `${value / 1000} sec`
  return `${(value / 1000).toFixed(1)} sec`
}

function formatKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase())
}

function useCodeTokens(code: string): TokenLine[] | null {
  const isDark = useIsDarkMode()
  const [tokens, setTokens] = useState<TokenLine[] | null>(null)

  useEffect(() => {
    let cancelled = false
    highlightCode(code, "typescript", isDark).then((result) => {
      if (!cancelled && result && result.length > 0) setTokens(result)
    })
    return () => {
      cancelled = true
    }
  }, [code, isDark])

  return tokens
}

function getNumberProperty(script: string, property: string): number | null {
  const match = script.match(new RegExp(`\\b${property}\\s*:\\s*([\\d_]+)`))
  if (!match) return null
  const value = Number(match[1].replace(/_/g, ""))
  return Number.isFinite(value) ? value : null
}

function getStringProperty(script: string, property: string): string | null {
  const match = script.match(new RegExp(`\\b${property}\\s*:\\s*["']([^"']+)["']`))
  return match?.[1] ?? null
}

function getCodexMetadata(script: string): InputMeta[] {
  const items: InputMeta[] = []
  const toolNames = new Set(
    Array.from(script.matchAll(/\btools\.([A-Za-z_$][\w$]*)\s*\(/g), (match) => match[1]),
  )
  for (const toolName of toolNames) {
    items.push({ key: `tool-${toolName}`, label: "Tool", value: formatKey(toolName) })
  }

  const workdir = getStringProperty(script, "workdir")
  if (workdir) items.push({ key: "workdir", label: "Working directory", value: workdir })

  const yieldTime = getNumberProperty(script, "yield_time_ms")
  if (yieldTime !== null) {
    items.push({ key: "yield-time", label: "Yield", value: formatTimeout(yieldTime), icon: Clock3 })
  }

  const outputLimit = getNumberProperty(script, "max_output_tokens")
  if (outputLimit !== null) {
    items.push({ key: "output-limit", label: "Output limit", value: `${outputLimit.toLocaleString()} tokens` })
  }

  return items
}

export function CodexExecToolInput({ input }: { input: Record<string, unknown> }): React.ReactElement {
  const script = String(input.raw ?? "")
  const metadata = getCodexMetadata(script)
  const [copied, copyScript] = useCopyWithFeedback()
  const tokens = useCodeTokens(script)
  const lines = script.split("\n")

  return (
    <Card size="sm" className="mt-1.5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Code2 className="size-4" aria-hidden="true" />
          Tool script
        </CardTitle>
        <CardAction>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => copyScript(script)}
            aria-label={copied ? "Tool script copied" : "Copy script"}
            title={copied ? "Copied" : "Copy script"}
          >
            {copied ? <Check data-icon="inline-start" aria-hidden="true" /> : <Copy data-icon="inline-start" aria-hidden="true" />}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-md bg-muted/50 p-3">
          <pre className="m-0 min-w-0 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
            <code aria-label="Codex exec script" className={cn("block", !tokens && "text-foreground")}>
              {lines.map((line, index) => {
                const tokenLine = tokens?.[index]
                return (
                  <span key={index} className="block min-h-lh">
                    {tokenLine
                      ? tokenLine.map((token, tokenIndex) => (
                          <span key={tokenIndex} style={{ color: token.color }}>{token.content}</span>
                        ))
                      : line || "\u00A0"}
                  </span>
                )
              })}
            </code>
          </pre>
        </div>
      </CardContent>
      {metadata.length > 0 && (
        <CardFooter className="items-stretch">
          <dl className="grid w-full gap-1.5" aria-label="Tool script options">
            {metadata.map((item) => {
              const MetaIcon = item.icon
              return (
                <div key={item.key} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2 text-xs">
                  <dt className="flex items-center gap-1 text-muted-foreground">
                    {MetaIcon && <MetaIcon className="size-3" aria-hidden="true" />}
                    {item.label}
                  </dt>
                  <dd className="min-w-0 break-all font-mono text-card-foreground">{item.value}</dd>
                </div>
              )
            })}
          </dl>
        </CardFooter>
      )}
    </Card>
  )
}
