import { useState, useCallback, useRef, memo } from "react"
import { Search, X, Clock, MessageSquare, ChevronRight, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { authFetch } from "@/lib/auth"

// ── Types matching /api/session-search response ────────────────────────────

interface SearchHit {
  location: string
  snippet: string
  matchCount: number
  toolName?: string
  agentName?: string
}

interface SessionSearchResult {
  sessionId: string
  dirName?: string
  hits: SearchHit[]
}

interface SearchResponse {
  query: string
  totalHits: number
  returnedHits: number
  sessionsSearched: number
  results: SessionSearchResult[]
}

// ── Props ──────────────────────────────────────────────────────────────────

export interface CrossSessionSearchProps {
  onOpenSession: (dirName: string, sessionId: string, turnIndex?: number) => void
}

// ── Max age options ────────────────────────────────────────────────────────

const MAX_AGE_OPTIONS = [
  { label: "1h", value: "1h" },
  { label: "1d", value: "1d" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "All", value: "365d" },
]

// ── Helpers ────────────────────────────────────────────────────────────────

function parseTurnIndex(location: string): number | undefined {
  const match = location.match(/^turn\/(\d+)/)
  return match ? parseInt(match[1], 10) : undefined
}

function highlightSnippet(snippet: string, query: string): React.ReactNode {
  if (!query || query.length < 2) return snippet
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi")
  const parts = snippet.split(regex)
  return parts.map((part, i) =>
    regex.test(part) ? (
      <mark key={i} className="bg-yellow-500/30 text-inherit rounded-sm px-0.5">
        {part}
      </mark>
    ) : (
      part
    ),
  )
}

function formatLocation(location: string): string {
  if (location.startsWith("turn/")) {
    const parts = location.split("/")
    const turnIdx = parseInt(parts[1], 10)
    const rest = parts.slice(2).join("/")
    return `Turn ${turnIdx + 1}${rest ? ` — ${rest}` : ""}`
  }
  if (location.startsWith("agent/")) {
    const parts = location.split("/")
    return `Agent ${parts[1]?.slice(0, 8)} — ${parts.slice(2).join("/")}`
  }
  return location
}

// ── Hit row ────────────────────────────────────────────────────────────────

const HitRow = memo(function HitRow({
  hit,
  query,
  sessionId,
  dirName,
  onOpenSession,
}: {
  hit: SearchHit
  query: string
  sessionId: string
  dirName?: string
  onOpenSession: (dirName: string, sessionId: string, turnIndex?: number) => void
}) {
  const turnIndex = parseTurnIndex(hit.location)

  return (
    <button
      className="w-full text-left px-2 py-1 hover:bg-elevation-2/50 rounded transition-colors group"
      onClick={() => dirName && onOpenSession(dirName, sessionId, turnIndex)}
      disabled={!dirName}
    >
      <div className="flex items-center gap-1 text-[9px] text-muted-foreground/60">
        <span className="truncate">{formatLocation(hit.location)}</span>
        {hit.matchCount > 1 && (
          <span className="text-[8px] text-muted-foreground/40">({hit.matchCount})</span>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground/80 line-clamp-2 mt-0.5">
        {highlightSnippet(hit.snippet, query)}
      </p>
    </button>
  )
})

// ── Session group ──────────────────────────────────────────────────────────

const SessionGroup = memo(function SessionGroup({
  result,
  query,
  onOpenSession,
}: {
  result: SessionSearchResult
  query: string
  onOpenSession: (dirName: string, sessionId: string, turnIndex?: number) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const totalHits = result.hits.reduce((sum, h) => sum + h.matchCount, 0)

  return (
    <div className="border-b border-border/20 last:border-0">
      <button
        className="flex items-center gap-1.5 w-full px-2 py-1.5 hover:bg-elevation-2/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronRight className="size-3 text-muted-foreground/50 rotate-90 transition-transform" />
        ) : (
          <ChevronRight className="size-3 text-muted-foreground/50 transition-transform" />
        )}
        <MessageSquare className="size-3 text-blue-400/60 shrink-0" />
        <span className="text-[10px] font-mono text-muted-foreground truncate">
          {result.sessionId.slice(0, 8)}
        </span>
        <span className="text-[9px] text-muted-foreground/40 shrink-0">
          {totalHits} hit{totalHits !== 1 ? "s" : ""}
        </span>
      </button>

      {expanded && (
        <div className="pl-2 pb-1">
          {result.hits.map((hit, i) => (
            <HitRow
              key={i}
              hit={hit}
              query={query}
              sessionId={result.sessionId}
              dirName={result.dirName}
              onOpenSession={onOpenSession}
            />
          ))}
        </div>
      )}
    </div>
  )
})

// ── Main component ─────────────────────────────────────────────────────────

export const CrossSessionSearch = memo(function CrossSessionSearch({
  onOpenSession,
}: CrossSessionSearchProps) {
  const [query, setQuery] = useState("")
  const [maxAge, setMaxAge] = useState("7d")
  const [results, setResults] = useState<SearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const handleSearch = useCallback(async () => {
    if (query.length < 2) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams({
        q: query,
        maxAge,
        limit: "50",
      })
      const res = await authFetch(`/api/session-search?${params}`, {
        signal: controller.signal,
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Search failed" }))
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      const data: SearchResponse = await res.json()
      setResults(data)
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [query, maxAge])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleSearch()
      if (e.key === "Escape") {
        setQuery("")
        setResults(null)
        inputRef.current?.blur()
      }
    },
    [handleSearch],
  )

  const handleClear = useCallback(() => {
    setQuery("")
    setResults(null)
    setError(null)
    inputRef.current?.focus()
  }, [])

  return (
    <div className="flex flex-col h-full">
      {/* Search input */}
      <div className="shrink-0 px-2 pt-2 pb-1 space-y-1.5">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search all sessions..."
            className="w-full h-7 pl-7 pr-7 text-xs bg-elevation-2 border border-border/40 rounded focus:outline-none focus:ring-1 focus:ring-blue-500/30 placeholder:text-muted-foreground/40"
          />
          {query && (
            <button
              onClick={handleClear}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
            >
              <X className="size-3" />
            </button>
          )}
        </div>

        {/* Date range filter */}
        <div className="flex items-center gap-1">
          <Clock className="size-3 text-muted-foreground/40 shrink-0" />
          {MAX_AGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setMaxAge(opt.value)}
              className={cn(
                "px-1.5 py-0.5 text-[9px] rounded transition-colors",
                maxAge === opt.value
                  ? "bg-blue-500/20 text-blue-400"
                  : "text-muted-foreground/50 hover:text-muted-foreground hover:bg-elevation-2/50",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-4 text-muted-foreground/50 animate-spin" />
          </div>
        )}

        {error && (
          <div className="px-3 py-4 text-[11px] text-red-400 text-center">
            {error}
          </div>
        )}

        {results && !loading && (
          <>
            <div className="px-2 py-1 text-[9px] text-muted-foreground/50 border-b border-border/20">
              {results.totalHits} hit{results.totalHits !== 1 ? "s" : ""} in{" "}
              {results.results.length} session{results.results.length !== 1 ? "s" : ""}
              <span className="ml-1">({results.sessionsSearched} searched)</span>
            </div>

            {results.results.length === 0 && (
              <div className="px-3 py-8 text-[11px] text-muted-foreground/50 text-center">
                No results found
              </div>
            )}

            {results.results.map((result) => (
              <SessionGroup
                key={result.sessionId}
                result={result}
                query={query}
                onOpenSession={onOpenSession}
              />
            ))}
          </>
        )}

        {!results && !loading && !error && (
          <div className="px-3 py-8 text-[11px] text-muted-foreground/50 text-center">
            Type a query and press Enter to search
          </div>
        )}
      </div>
    </div>
  )
})
