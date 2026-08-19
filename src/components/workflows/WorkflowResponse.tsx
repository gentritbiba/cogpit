import { useMemo } from "react"
import ReactMarkdown from "react-markdown"
import {
  markdownComponents,
  markdownPlugins,
  preprocessImagePaths,
} from "@/components/timeline/markdown-components"
import { cn } from "@/lib/utils"

const SUMMARY_KEYS = ["headline", "oneLineSell", "verdict", "summary", "name", "lens"]
const TITLE_KEYS = new Set(["title", "name"])
const LEAD_KEYS = new Set(["headline", "oneLineSell", "verdict"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseJson(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value

  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return value
  }
}

function decodeJsonFragment(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string
  } catch {
    return value.replace(/\\n/g, " ").replace(/\\"/g, '"')
  }
}

function stringSummary(value: string): string {
  const parsed = parseJson(value)
  if (parsed !== value) return responseSummary(parsed)

  for (const key of SUMMARY_KEYS) {
    const match = value.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`))
    if (match?.[1]) return decodeJsonFragment(match[1])
  }

  return value
    .replace(/^[#>*\s-]+/, "")
    .replace(/[`*_#]/g, "")
    .split(/\n\s*\n|\n/)[0]
    .trim()
}

export function responseSummary(value: unknown): string {
  if (typeof value === "string") return stringSummary(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return value.length > 0 ? responseSummary(value[0]) : ""

  if (isRecord(value)) {
    for (const key of SUMMARY_KEYS) {
      const candidate = value[key]
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim()
    }
  }

  return ""
}

export function serializeWorkflowResponse(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function humanizeKey(key: string): string {
  const labels: Record<string, string> = {
    oneLineSell: "In one line",
    quickWins: "Quick wins",
    whatIsLost: "What is lost",
    whyItHurts: "Why it hurts",
    restingState: "Resting state",
    fatalFlaws: "Fatal flaws",
    bestIdeasRegardlessOfConcept: "Best ideas across concepts",
  }

  if (labels[key]) return labels[key]
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase())
}

function MarkdownText({ children }: { children: string }) {
  const text = useMemo(() => preprocessImagePaths(children), [children])
  return (
    <ReactMarkdown components={markdownComponents} remarkPlugins={markdownPlugins}>
      {text}
    </ReactMarkdown>
  )
}

function PrimitiveValue({ value }: { value: unknown }) {
  if (typeof value === "string") return <MarkdownText>{value}</MarkdownText>
  if (value === null) return <span className="text-muted-foreground">None</span>
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>
  return <span>{String(value)}</span>
}

function StructuredValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (!isRecord(value) && !Array.isArray(value)) return <PrimitiveValue value={value} />

  if (depth > 5) {
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs text-muted-foreground">
        {serializeWorkflowResponse(value)}
      </pre>
    )
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <p className="text-sm text-muted-foreground">No items</p>

    const primitivesOnly = value.every((item) => !isRecord(item) && !Array.isArray(item))
    if (primitivesOnly) {
      return (
        <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-muted-foreground">
          {value.map((item, index) => (
            <li key={index} className="pl-1 text-sm leading-relaxed">
              <PrimitiveValue value={item} />
            </li>
          ))}
        </ul>
      )
    }

    return (
      <div className="flex flex-col gap-3">
        {value.map((item, index) => (
          <article key={index} className="border-l pl-4">
            <StructuredValue value={item} depth={depth + 1} />
          </article>
        ))}
      </div>
    )
  }

  const entries = Object.entries(value)
  const titleEntry = entries.find(([key, item]) =>
    TITLE_KEYS.has(key) && typeof item === "string" && item.trim().length > 0,
  )
  const contentEntries = entries.filter(([key]) => key !== titleEntry?.[0])

  return (
    <div className="flex flex-col gap-4">
      {titleEntry && (
        <h3 className={cn("font-semibold text-foreground", depth === 0 ? "text-lg" : "text-base")}>
          {titleEntry[1] as string}
        </h3>
      )}
      {contentEntries.map(([key, item]) => {
        if (item === undefined) return null
        const isLead = LEAD_KEYS.has(key) && typeof item === "string"

        if (isLead) {
          return (
            <div key={key} className="border-l-2 border-foreground/30 pl-4 text-sm font-medium leading-relaxed">
              <MarkdownText>{item}</MarkdownText>
            </div>
          )
        }

        return (
          <section key={key} className="flex min-w-0 flex-col gap-2">
            <h4 className="text-xs font-medium text-muted-foreground">
              {humanizeKey(key)}
            </h4>
            <div className="min-w-0 text-sm leading-relaxed">
              <StructuredValue value={item} depth={depth + 1} />
            </div>
          </section>
        )
      })}
    </div>
  )
}

export function WorkflowResponse({ value, className }: { value: unknown; className?: string }) {
  const parsed = useMemo(() => typeof value === "string" ? parseJson(value) : value, [value])
  const appearsToBeTruncatedJson = typeof parsed === "string" && (
    parsed.trim().startsWith("{") || parsed.trim().startsWith("[")
  )

  if (appearsToBeTruncatedJson) {
    const summary = responseSummary(parsed)
    return (
      <div className={cn("flex flex-col gap-2", className)}>
        {summary && <p className="text-sm leading-relaxed text-foreground">{summary}</p>}
        <p className="text-xs text-muted-foreground">Only a shortened preview was saved for this response.</p>
      </div>
    )
  }

  return (
    <div className={cn("min-w-0 text-sm", className)}>
      <StructuredValue value={parsed} />
    </div>
  )
}
