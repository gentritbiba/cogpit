import { useState } from "react"
import { Archive, Sparkles } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { formatRelativeTime, projectName } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { OpenSearchQuote } from "./types"
import type { SessionSearchHit, SessionSearchResponse, SessionSearchResult } from "../../../shared/contracts/sessionSearch"

interface Props {
  response: SessionSearchResponse | null
  onSelectSession: (dirName: string, fileName: string) => void
  onOpenQuoteSource?: OpenSearchQuote
}

const SPEAKER: Record<SessionSearchHit["kind"], string> = {
  user: "You", assistant: "Assistant", thinking: "Thinking", compaction: "Summary",
  recap: "Recap", plan: "Plan", agent_message: "Agent",
}

export function ConversationSearchResults({ response, onSelectSession, onOpenQuoteSource }: Props) {
  const [archived, setArchived] = useState<{ result: SessionSearchResult; hit: SessionSearchHit } | null>(null)
  if (!response) return null
  if (response.results.length === 0) return response.indexing.pendingFiles > 0
    ? <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Indexing conversations…</p>
    : null

  const select = (result: SessionSearchResult, hit: SessionSearchHit) => {
    if (result.archived) {
      setArchived({ result, hit })
      return
    }
    if (!result.dirName || !result.fileName) return
    if (onOpenQuoteSource && (hit.openTurnId !== null || hit.openTurn !== null)) {
      void onOpenQuoteSource({
        dirName: result.dirName, fileName: result.fileName,
        sessionId: result.sessionId, turnId: hit.openTurnId ?? "",
      }, "", hit.openTurn)
    } else onSelectSession(result.dirName, result.fileName)
  }

  return (
    <section aria-label="In conversations" className="flex min-w-0 flex-col gap-2">
      <h2 className="px-3 text-xs font-medium text-muted-foreground">In conversations</h2>
      {response.results.map((result) => {
        const date = result.hits.find((hit) => hit.timestamp)?.timestamp
        return (
          <div key={result.sessionId} className="overflow-hidden rounded-lg border bg-card">
            <div className="flex min-w-0 flex-col gap-1 px-3 pt-2.5 pb-1.5">
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="min-w-0 flex-1 truncate" title={result.cwd}>{projectName(result.cwd) || "Unknown project"}</span>
                {result.archived && <span className="inline-flex items-center gap-1"><Archive className="size-3" />Archived</span>}
                {date && <time dateTime={date} title={new Date(date).toLocaleString()}>{formatRelativeTime(date)}</time>}
              </div>
              <p className="truncate text-sm font-medium">{result.title || "Untitled session"}</p>
            </div>
            {result.hits.slice(0, 3).map((hit) => (
              <button
                key={hit.chunkId}
                type="button"
                data-session-search-item
                onClick={() => select(result, hit)}
                className={cn("flex w-full flex-col gap-1 border-t px-3 py-2 text-left text-xs outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", hit.automated && "text-muted-foreground")}
              >
                <span className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                  <span>{SPEAKER[hit.kind]}{hit.agentId ? " · subagent" : ""}{hit.automated ? " · automated" : ""}</span>
                  <span className="inline-flex items-center gap-1">
                    {hit.match !== "keyword" && <Sparkles className="size-2.5" aria-hidden="true" />}
                    {hit.match === "semantic" ? "By meaning" : hit.match === "both" ? "Keyword + meaning" : "Keyword"}
                  </span>
                </span>
                <span className="line-clamp-3 whitespace-pre-wrap break-words">{hit.snippet}</span>
              </button>
            ))}
          </div>
        )
      })}
      <Dialog open={archived !== null} onOpenChange={(open) => { if (!open) setArchived(null) }}>
        {archived && <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{archived.result.title || "Untitled session"}</DialogTitle>
            <DialogDescription>Archived conversation · {projectName(archived.result.cwd)} · Read-only stored text</DialogDescription>
          </DialogHeader>
          <div className="max-h-[65dvh] overflow-y-auto whitespace-pre-wrap break-words text-sm">{archived.hit.text ?? archived.hit.snippet}</div>
        </DialogContent>}
      </Dialog>
    </section>
  )
}
