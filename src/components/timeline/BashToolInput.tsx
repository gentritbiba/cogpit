import { useEffect, useState } from "react"
import { Check, Clock3, Code2, Copy, Play, Terminal, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback"
import { useIsDarkMode } from "@/hooks/useIsDarkMode"
import { highlightCode } from "@/lib/shiki"
import { cn } from "@/lib/utils"

type TokenLine = Array<{ content: string; color?: string }>

interface BashToolInputProps {
  input: Record<string, unknown>
}

interface InputMeta {
  key: string
  label: string
  value: string
  icon?: LucideIcon
}

interface ExecutableInputCardProps {
  title: string
  code: string
  language: string
  codeLabel: string
  copyLabel: string
  icon: LucideIcon
  prompt?: string
  description?: string
  metadata?: InputMeta[]
}

const STANDARD_BASH_KEYS = new Set([
  "command",
  "cmd",
  "description",
  "timeout",
  "run_in_background",
])

function formatTimeout(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value)
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

function formatValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function useCodeTokens(code: string, language: string): TokenLine[] | null {
  const isDark = useIsDarkMode()
  const [tokens, setTokens] = useState<TokenLine[] | null>(null)

  useEffect(() => {
    let cancelled = false
    highlightCode(code, language, isDark).then((result) => {
      if (!cancelled && result && result.length > 0) setTokens(result)
    })
    return () => {
      cancelled = true
    }
  }, [code, isDark, language])

  return tokens
}

function ExecutableInputCard({
  title,
  code,
  language,
  codeLabel,
  copyLabel,
  icon: Icon,
  prompt,
  description,
  metadata = [],
}: ExecutableInputCardProps): React.ReactElement {
  const [copied, copyCode] = useCopyWithFeedback()
  const tokens = useCodeTokens(code, language)
  const lines = code.split("\n")

  return (
    <Card size="sm" className="mt-1.5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4" aria-hidden="true" />
          {title}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        <CardAction>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => copyCode(code)}
            aria-label={copied ? `${title} copied` : copyLabel}
            title={copied ? "Copied" : copyLabel}
          >
            {copied ? (
              <Check data-icon="inline-start" aria-hidden="true" />
            ) : (
              <Copy data-icon="inline-start" aria-hidden="true" />
            )}
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent>
        <div className="flex items-start gap-2 overflow-x-auto rounded-md bg-muted/50 p-3">
          {prompt && (
            <span className="select-none font-mono text-xs text-muted-foreground" aria-hidden="true">
              {prompt}
            </span>
          )}
          <pre className="m-0 min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
            <code aria-label={codeLabel} className={cn("block", !tokens && "text-foreground")}>
              {lines.map((line, index) => {
                const tokenLine = tokens?.[index]
                return (
                  <span key={index} className="block min-h-lh">
                    {tokenLine
                      ? tokenLine.map((token, tokenIndex) => (
                          <span key={tokenIndex} style={{ color: token.color }}>
                            {token.content}
                          </span>
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
          <dl className="grid w-full gap-1.5" aria-label={`${title} options`}>
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

function getBashMetadata(input: Record<string, unknown>): InputMeta[] {
  const items: InputMeta[] = []

  if (input.timeout !== undefined) {
    items.push({
      key: "timeout",
      label: "Timeout",
      value: formatTimeout(input.timeout),
      icon: Clock3,
    })
  }

  if (typeof input.run_in_background === "boolean") {
    items.push({
      key: "run_in_background",
      label: "Execution",
      value: input.run_in_background ? "Background" : "Foreground",
      icon: Play,
    })
  }

  for (const [key, value] of Object.entries(input)) {
    if (STANDARD_BASH_KEYS.has(key) || value === undefined) continue
    items.push({ key, label: formatKey(key), value: formatValue(value) })
  }

  return items
}

export function BashToolInput({ input }: BashToolInputProps): React.ReactElement {
  const command = String(input.command ?? input.cmd ?? "")
  const description = typeof input.description === "string" ? input.description : ""
  const metadata = getBashMetadata(input)

  return (
    <ExecutableInputCard
      title="Command"
      code={command}
      language="bash"
      codeLabel="Bash command"
      copyLabel="Copy command"
      icon={Terminal}
      prompt="$"
      description={description}
      metadata={metadata}
    />
  )
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

export function CodexExecToolInput({ input }: BashToolInputProps): React.ReactElement {
  const script = String(input.raw ?? "")
  const metadata = getCodexMetadata(script)

  return (
    <ExecutableInputCard
      title="Tool script"
      code={script}
      language="typescript"
      codeLabel="Codex exec script"
      copyLabel="Copy script"
      icon={Code2}
      metadata={metadata}
    />
  )
}

function getCodexMetadata(script: string): InputMeta[] {
  const items: InputMeta[] = []
  const toolNames = new Set(
    Array.from(script.matchAll(/\btools\.([A-Za-z_$][\w$]*)\s*\(/g), (match) => match[1]),
  )
  for (const toolName of toolNames) {
    items.push({
      key: `tool-${toolName}`,
      label: "Tool",
      value: formatKey(toolName),
    })
  }

  const workdir = getStringProperty(script, "workdir")
  if (workdir) {
    items.push({ key: "workdir", label: "Working directory", value: workdir })
  }

  const yieldTime = getNumberProperty(script, "yield_time_ms")
  if (yieldTime !== null) {
    items.push({ key: "yield-time", label: "Yield", value: formatTimeout(yieldTime), icon: Clock3 })
  }

  const outputLimit = getNumberProperty(script, "max_output_tokens")
  if (outputLimit !== null) {
    items.push({
      key: "output-limit",
      label: "Output limit",
      value: `${outputLimit.toLocaleString()} tokens`,
    })
  }

  return items
}
