import { useEffect, useMemo } from "react"
import { Shield, Terminal, PenLine, Eye, Search, Globe, Wrench, Check, X, Infinity as InfinityIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
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
    .map((k) => {
      const v = input[k]
      const s = typeof v === "string" ? v : JSON.stringify(v)
      return s && s.length > 160 ? s.slice(0, 157) + "…" : s
    })
    .filter(Boolean)
    .join(" · ")
}

export function PermissionRequestBar({ requests, responding, onRespond, onRespondAll }: PermissionRequestBarProps) {
  const current = requests[0]
  const remaining = requests.length

  // Keyboard shortcuts:
  //   A = allow once · S = always for session · D = deny · Shift+A = allow all (multi)
  useEffect(() => {
    if (!current) return
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === "a" && e.shiftKey && remaining > 1) {
        e.preventDefault()
        onRespondAll("allow")
      } else if (key === "a") {
        e.preventDefault()
        onRespond(current.requestId, "allow")
      } else if (key === "s") {
        e.preventDefault()
        onRespond(current.requestId, "allow_always")
      } else if (key === "d") {
        e.preventDefault()
        onRespond(current.requestId, "deny")
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [current, remaining, onRespond, onRespondAll])

  const meta = useMemo(() => (current ? getToolMeta(current.toolName) : null), [current])
  const detail = useMemo(() => (current ? getToolDetail(current.toolName, current.input) : null), [current])

  if (!current || !meta) return null
  const Icon = meta.icon
  const isLoading = responding.has(current.requestId)
  const isMulti = remaining > 1

  return (
    <div className="border-b border-amber-500/20 bg-gradient-to-b from-amber-500/[0.07] to-transparent">
      <div className="flex items-center gap-3 px-4 py-2.5">
        {/* Leading: shield + tool label */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center justify-center size-6 rounded-md bg-amber-500/15 ring-1 ring-amber-500/30">
            <Shield className="size-3.5 text-amber-400" />
          </div>
          <div className="flex items-center gap-1.5">
            <Icon className="size-3.5 text-amber-300/70" />
            <span className="text-xs font-medium text-foreground">{meta.label}</span>
          </div>
        </div>

        {/* Detail — fills available space, truncates */}
        {detail && (
          <div className="flex-1 min-w-0">
            <code className="block truncate text-[11px] text-muted-foreground/90 font-mono bg-black/25 rounded px-2 py-1 border border-white/5">
              {detail}
            </code>
          </div>
        )}

        {/* Multi-request counter */}
        {isMulti && (
          <span className="shrink-0 text-[10px] font-medium text-amber-300/70 tabular-nums bg-amber-500/10 rounded px-1.5 py-0.5">
            +{remaining - 1} more
          </span>
        )}

        {/* Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-xs text-muted-foreground hover:text-red-400 hover:bg-red-500/10 gap-1"
            disabled={isLoading}
            onClick={() => onRespond(current.requestId, "deny")}
            title="Deny (D)"
          >
            <X className="size-3" />
            Deny
            <kbd className="ml-0.5 text-[9px] font-mono text-muted-foreground/50">D</kbd>
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-xs text-amber-300/80 hover:text-amber-200 hover:bg-amber-500/10 gap-1"
            disabled={isLoading}
            onClick={() => onRespond(current.requestId, "allow_always")}
            title={`Allow ${current.toolName} for this session (S)`}
          >
            <InfinityIcon className="size-3" />
            Session
            <kbd className="ml-0.5 text-[9px] font-mono text-amber-300/50">S</kbd>
          </Button>

          {isMulti && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2.5 text-xs text-amber-300/80 hover:text-amber-200 hover:bg-amber-500/10 gap-1"
              disabled={isLoading}
              onClick={() => onRespondAll("allow")}
              title="Allow all pending (⇧A)"
            >
              Allow all
              <kbd className="ml-0.5 text-[9px] font-mono text-amber-300/50">⇧A</kbd>
            </Button>
          )}

          <Button
            size="sm"
            className="h-7 px-3 text-xs bg-emerald-600 hover:bg-emerald-500 text-white border-0 font-medium gap-1 shadow-sm shadow-emerald-900/40"
            disabled={isLoading}
            onClick={() => onRespond(current.requestId, "allow")}
            title="Allow once (A)"
          >
            <Check className="size-3" />
            Allow
            <kbd className="ml-0.5 text-[9px] font-mono text-emerald-100/70">A</kbd>
          </Button>
        </div>
      </div>
    </div>
  )
}
