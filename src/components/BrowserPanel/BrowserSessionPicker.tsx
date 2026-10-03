import { useRef, useState, type ReactNode } from "react"
import { Archive, ArchiveRestore, ArrowLeft, Check, ChevronDown, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { formatRelativeTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { BrowserActionResult } from "@/hooks/useBrowserSessions"
import type { BrowserSessionInfo } from "../../../shared/browser/types"
import { browserLabel, controlOf } from "./browserSessions"

interface BrowserSessionPickerProps {
  sessions: BrowserSessionInfo[]
  selected: string
  /** The caller's default browser, which never archives. */
  home: string
  currentSessionId: string | null
  busy: boolean
  onSelect: (name: string) => void
  onSetArchived: (name: string, archived: boolean) => Promise<BrowserActionResult>
  children: (close: () => void) => ReactNode
}

function lastUsedLabel(iso: string | null): string | null {
  if (!iso || !Number.isFinite(Date.parse(iso))) return null
  if (Date.now() - Date.parse(iso) >= 7 * 24 * 60 * 60 * 1000) return new Date(iso).toLocaleDateString()
  const relative = formatRelativeTime(iso)
  return relative === "now" ? "just now" : `${relative} ago`
}

function StatusDot({ running }: { running: boolean }) {
  return <span aria-hidden className={cn("size-2 shrink-0 rounded-full", running ? "bg-emerald-500" : "ring-1 ring-muted-foreground/50 ring-inset")} />
}

export function BrowserSessionPicker({
  sessions, selected, home, currentSessionId, busy, onSelect, onSetArchived, children,
}: BrowserSessionPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [showArchived, setShowArchived] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const selectedInfo = sessions.find((session) => session.name === selected)
  const search = query.trim().toLowerCase()
  const isArchived = (session: BrowserSessionInfo) => !!session.archived
    && !session.isDefault && session.name !== home && !session.running && session.name !== selected
  const matches = (session: BrowserSessionInfo) => `${session.name} ${browserLabel(session, session.name)} ${session.note ?? ""}`
    .toLowerCase().includes(search)
  const recent = sessions.filter((session) => !isArchived(session) && matches(session))
    .sort((a, b) => Number(b.name === home) - Number(a.name === home)
      || Number(b.isDefault) - Number(a.isDefault)
      || Number(b.running) - Number(a.running))
  const allArchived = sessions.filter(isArchived)
  const archived = allArchived.filter(matches)
  const visibleRecent = showArchived && !search ? [] : recent
  const visibleArchived = showArchived || search ? archived : []

  function close() { setOpen(false) }

  async function pick(session: BrowserSessionInfo) {
    if (session.archived) {
      const result = await onSetArchived(session.name, false)
      if (!result.ok) return
    }
    onSelect(session.name)
    close()
  }

  async function archive(name: string) {
    const result = await onSetArchived(name, true)
    if (result.ok) searchRef.current?.focus()
  }

  return (
    <Popover open={open} onOpenChange={(next) => {
      setOpen(next)
      if (next) { setQuery(""); setShowArchived(false) }
    }}>
      <PopoverTrigger render={<Button variant="ghost" size="xs" aria-label="Switch browser" className="max-w-40" />}>
        <StatusDot running={selectedInfo?.running ?? false} />
        <span className="truncate">{browserLabel(selectedInfo, selected)}</span>
        <ChevronDown data-icon="inline-end" className="opacity-60" />
      </PopoverTrigger>
      <PopoverContent
        aria-label="Browsers"
        initialFocus={searchRef}
        className="flex max-h-[min(32rem,var(--available-height))] w-80 max-w-[calc(100vw-1rem)] flex-col overflow-hidden"
      >
        <div className="flex shrink-0 flex-col gap-2 p-2">
          <div className="flex items-center justify-between pl-1">
            <span className="text-sm font-medium">{showArchived && !search ? "Archived browsers" : "Browsers"}</span>
            <Button variant="ghost" size="icon-xs" aria-label="Close browser picker" onClick={close}><X data-icon="inline-start" /></Button>
          </div>
          <Input ref={searchRef} aria-label="Search browsers" placeholder="Search browsers…" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <Separator />
        <div className="min-h-0 max-h-72 overflow-y-auto overscroll-contain p-1" aria-label="Browser list">
          {[
            { label: "Recent browsers", sessions: visibleRecent, archived: false },
            { label: "Archived browsers", sessions: visibleArchived, archived: true },
          ].filter((group) => group.sessions.length > 0).map((group) => (
            <div key={group.label}>
              {group.archived && !!search && <p className="px-2 py-1 text-xs text-muted-foreground">Archived</p>}
              <ul aria-label={group.label}>
                {group.sessions.map((session) => (
                  <BrowserSessionRow
                    key={session.name}
                    session={session}
                    archived={group.archived}
                    home={home}
                    selected={selected}
                    currentSessionId={currentSessionId}
                    busy={busy}
                    onPick={pick}
                    onArchive={archive}
                  />
                ))}
              </ul>
            </div>
          ))}
          {visibleRecent.length === 0 && visibleArchived.length === 0 && <p role="status" className="px-3 py-6 text-center text-sm text-muted-foreground">No browsers found.</p>}
        </div>
        <Separator />
        <div className="flex shrink-0 flex-col gap-1 p-2">
          {(allArchived.length > 0 || showArchived) && (
            <Button variant="ghost" size="sm" className="w-full justify-start" aria-expanded={showArchived} onClick={() => { setShowArchived(!showArchived); setQuery("") }}>
              {showArchived ? <ArrowLeft data-icon="inline-start" /> : <Archive data-icon="inline-start" />}
              {showArchived ? "Back to recent" : "Archived"}
              {!showArchived && <Badge variant="secondary">{allArchived.length}</Badge>}
            </Button>
          )}
          <p className="px-1 pb-1 text-xs text-muted-foreground">Stopped browsers archive after 24h of inactivity. Saved logins are kept.</p>
          {children(close)}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function BrowserSessionRow({ session, archived, home, selected, currentSessionId, busy, onPick, onArchive }: {
  session: BrowserSessionInfo
  archived: boolean
  home: string
  selected: string
  currentSessionId: string | null
  busy: boolean
  onPick: (session: BrowserSessionInfo) => Promise<void>
  onArchive: (name: string) => Promise<void>
}) {
  const lastUsed = lastUsedLabel(session.lastUsedAt)
  const label = browserLabel(session, session.name)
  const drivenElsewhere = session.running && session.driverSessionId !== null
    && session.driverSessionId !== currentSessionId
  // Beside an own browser of the caller's, the host's `default` is not theirs.
  const defaultBadge = session.isDefault ? (home === session.name ? "Default" : "Host default") : null
  return (
    <li className="group flex items-center gap-1 rounded-md">
      <Button
        variant="ghost"
        className="h-auto min-h-10 min-w-0 flex-1 justify-start px-2 py-2"
        aria-label={`${archived ? "Restore and switch to" : "Switch to"} ${label}`}
        aria-current={session.name === selected ? "true" : undefined}
        disabled={busy}
        onClick={() => void onPick(session)}
      >
        <StatusDot running={session.running} />
        <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <span className="flex w-full min-w-0 items-center gap-1.5">
            <span className="truncate">{label}</span>
            <span className="sr-only">{session.running ? "running" : "stopped"}</span>
            {defaultBadge && <Badge variant="secondary">{defaultBadge}</Badge>}
            {controlOf(session) === "watch" && <Badge variant="outline">View only</Badge>}
            {lastUsed && <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground">{lastUsed}</span>}
          </span>
          {drivenElsewhere && <span className="max-w-full truncate text-xs font-normal text-muted-foreground">driven by another session</span>}
        </span>
        {session.name === selected && <Check data-icon="inline-end" />}
        {archived && <ArchiveRestore data-icon="inline-end" />}
      </Button>
      {!archived && !session.isDefault && session.name !== home && !session.running && controlOf(session) === "own" && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Archive ${session.name}`}
          title={`Archive ${session.name}`}
          disabled={busy}
          onClick={() => void onArchive(session.name)}
        >
          <Archive data-icon="inline-start" />
        </Button>
      )}
    </li>
  )
}

