import { useEffect, useEffectEvent } from "react"
import { Shield, Terminal, PenLine, Eye, Search, Globe, Wrench, Check, X, Infinity as InfinityIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import type { PermissionRequest, PermissionDecision } from "@/hooks/usePermissionRequests"

interface PermissionRequestBarProps {
  requests: PermissionRequest[]
  responding: Set<string>
  onRespond: (requestId: string, behavior: PermissionDecision) => void
  onRespondAll: (behavior: PermissionDecision) => void
}

interface ToolMeta {
  label: string
  icon: typeof Terminal
  tone: "cmd" | "write" | "read" | "search" | "net" | "other"
}

const DEFAULT_DECISIONS: readonly PermissionDecision[] = [
  "allow",
  "allow_always",
  "deny",
]

function supportsDecision(
  request: PermissionRequest,
  decision: PermissionDecision,
): boolean {
  return (request.availableDecisions ?? DEFAULT_DECISIONS).includes(decision)
}

function getToolMeta(toolName: string): ToolMeta {
  switch (toolName) {
    case "Bash": return { label: "Run command", icon: Terminal, tone: "cmd" }
    case "Edit": return { label: "Edit file", icon: PenLine, tone: "write" }
    case "Write": return { label: "Write file", icon: PenLine, tone: "write" }
    case "Read": return { label: "Read file", icon: Eye, tone: "read" }
    case "Glob": return { label: "File search", icon: Search, tone: "search" }
    case "Grep": return { label: "Content search", icon: Search, tone: "search" }
    case "WebFetch": return { label: "Fetch URL", icon: Globe, tone: "net" }
    case "WebSearch": return { label: "Web search", icon: Globe, tone: "net" }
    default: return { label: toolName, icon: Wrench, tone: "other" }
  }
}

function getToolDetail(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === "Bash" && typeof input.command === "string") return input.command
  if ((toolName === "Edit" || toolName === "Write" || toolName === "Read") && typeof input.file_path === "string") return input.file_path
  if ((toolName === "Glob" || toolName === "Grep") && typeof input.pattern === "string") return input.pattern
  if (toolName === "WebFetch" && typeof input.url === "string") return input.url
  if (toolName === "WebSearch" && typeof input.query === "string") return input.query

  const keys = Object.keys(input).slice(0, 2)
  if (keys.length === 0) return null
  return keys
    .flatMap((k) => {
      const v = input[k]
      const s = typeof v === "string" ? v : JSON.stringify(v)
      if (!s) return []
      return [s.length > 160 ? s.slice(0, 157) + "…" : s]
    })
    .join(" · ")
}

export function PermissionRequestBar({ requests, responding, onRespond, onRespondAll }: PermissionRequestBarProps) {
  const current = requests[0]
  const remaining = requests.length
  const canAllow = current ? supportsDecision(current, "allow") : false
  const canAllowAlways = current
    ? supportsDecision(current, "allow_always")
    : false
  const canDeny = current ? supportsDecision(current, "deny") : false
  const canAllowAll =
    remaining > 1 && requests.every((request) => supportsDecision(request, "allow"))

  // Keyboard shortcuts:
  //   A = allow once · S = always for session · D = deny · Shift+A = allow all (multi)
  const handleShortcut = useEffectEvent((e: KeyboardEvent) => {
    if (!current) return
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const key = e.key.toLowerCase()
    if (key === "a" && e.shiftKey && canAllowAll) {
      e.preventDefault()
      onRespondAll("allow")
    } else if (key === "a" && canAllow) {
      e.preventDefault()
      onRespond(current.requestId, "allow")
    } else if (key === "s" && canAllowAlways) {
      e.preventDefault()
      onRespond(current.requestId, "allow_always")
    } else if (key === "d" && canDeny) {
      e.preventDefault()
      onRespond(current.requestId, "deny")
    }
  })

  useEffect(() => {
    const handler = (event: KeyboardEvent) => handleShortcut(event)
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
    // Effect Events are intentionally non-reactive and omitted from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const meta = current ? getToolMeta(current.toolName) : null
  const detail = current ? getToolDetail(current.toolName, current.input) : null
  const rationale = current?.decisionReason || current?.description || current?.blockedPath
  const hasScopedSuggestion = (current?.suggestions?.length ?? 0) > 0

  if (!current || !meta) return null
  const Icon = meta.icon
  const isLoading = responding.has(current.requestId)
  const isMulti = remaining > 1

  return (
    <div className="border-b border-warning/20 bg-warning/5">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-warning/10 text-warning">
            <Shield className="size-4" />
          </div>
          <div className="flex items-center gap-1.5">
            <Icon className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">{meta.label}</span>
          </div>
        </div>

        {detail && (
          <div className="min-w-0 flex-1">
            <code className="block truncate rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs text-muted-foreground">
              {detail}
            </code>
          </div>
        )}

        {rationale && rationale !== detail && (
          <p className="hidden max-w-64 truncate text-xs text-muted-foreground xl:block" title={rationale}>
            {rationale}
          </p>
        )}

        {isMulti && (
          <Badge variant="outline" className="shrink-0 tabular-nums">
            +{remaining - 1} more
          </Badge>
        )}

        <div className="flex shrink-0 items-center gap-1.5">
          {canDeny && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              disabled={isLoading}
              onClick={() => onRespond(current.requestId, "deny")}
              title="Deny (D)"
            >
              <X data-icon="inline-start" />
              Deny
              <kbd className="ml-0.5 font-mono text-xs text-muted-foreground">D</kbd>
            </Button>
          )}

          {canAllowAlways && (
            <Button
              variant="outline"
              size="sm"
              disabled={isLoading}
              onClick={() => onRespond(current.requestId, "allow_always")}
              title={hasScopedSuggestion
                ? "Apply Claude's suggested scoped permission rule (S)"
                : `Allow ${current.toolName} for this session (S)`}
            >
              <InfinityIcon data-icon="inline-start" />
              {hasScopedSuggestion ? "Remember rule" : "Session"}
              <kbd className="ml-0.5 font-mono text-xs text-muted-foreground">S</kbd>
            </Button>
          )}

          {canAllowAll && (
            <Button
              variant="secondary"
              size="sm"
              disabled={isLoading}
              onClick={() => onRespondAll("allow")}
              title="Allow all pending (⇧A)"
            >
              Allow all
              <kbd className="ml-0.5 font-mono text-xs text-muted-foreground">⇧A</kbd>
            </Button>
          )}

          {canAllow && (
            <Button
              size="sm"
              disabled={isLoading}
              onClick={() => onRespond(current.requestId, "allow")}
              title="Allow once (A)"
            >
              <Check data-icon="inline-start" />
              Allow
              <kbd className="ml-0.5 font-mono text-xs opacity-70">A</kbd>
            </Button>
          )}

          {!canAllow && !canAllowAlways && !canDeny && (
            <span className="text-xs text-muted-foreground">
              Resolve this approval in Codex
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
