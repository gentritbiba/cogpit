import { memo, useId, useState } from "react"
import { ChevronDown, CircleStop, Crosshair, Plus, Trash2, TriangleAlert, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Toggle } from "@/components/ui/toggle"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatRelativeTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { BrowserActionResult } from "@/hooks/useBrowserSessions"
import type { BrowserSessionInfo } from "../../../shared/browser/types"

/**
 * Which browser the panel is showing, and everything that changes that: the
 * picker, creating and removing named browsers, following the agent, and the
 * standing reminder when the visible browser is not the shared default.
 */

export const DEFAULT_BROWSER = "default"

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/
const NAME_RULE = "Lowercase letters, numbers, - and _, starting with a letter or number (40 max)."
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

interface BrowserSessionBarProps {
  sessions: BrowserSessionInfo[]
  selected: string
  /** This Cogpit session, so a browser another one drives can say so. */
  currentSessionId: string | null
  followAgent: boolean
  /** A browser action is already in flight; the mutating controls stand down. */
  busy?: boolean
  onSelect: (name: string) => void
  onToggleFollow: (next: boolean) => void
  onCreate: (name: string, note: string) => Promise<BrowserActionResult>
  onRemove: (name: string) => void
  onStop: (name: string) => void
  onShowDefault: () => void
  onClose: () => void
}

/** "2m ago" while it is recent, a plain date once it is older than a week. */
function lastUsedLabel(iso: string | null): string | null {
  if (!iso) return null
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return null
  if (Date.now() - at >= WEEK_MS) return new Date(at).toLocaleDateString()
  const relative = formatRelativeTime(iso)
  return relative === "now" ? "just now" : `${relative} ago`
}

function StatusDot({ running, className }: { running: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-full",
        running ? "bg-emerald-500" : "ring-1 ring-muted-foreground/50 ring-inset",
        className,
      )}
    />
  )
}

export const BrowserSessionBar = memo(function BrowserSessionBar({
  sessions,
  selected,
  currentSessionId,
  followAgent,
  busy = false,
  onSelect,
  onToggleFollow,
  onCreate,
  onRemove,
  onStop,
  onShowDefault,
  onClose,
}: BrowserSessionBarProps) {
  const nameId = useId()
  const noteId = useId()
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState("")
  const [newNote, setNewNote] = useState("")
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const isDefault = selected === DEFAULT_BROWSER
  const selectedInfo = sessions.find((session) => session.name === selected) ?? null

  const trimmedName = newName.trim()
  const nameBroken = trimmedName.length > 0 && !NAME_PATTERN.test(trimmedName)
  const createMessage = nameBroken ? NAME_RULE : createError
  const canCreate = trimmedName.length > 0 && !nameBroken && !creating

  function openCreate(): void {
    setNewName("")
    setNewNote("")
    setCreateError(null)
    setCreating(false)
    setCreateOpen(true)
  }

  async function submitCreate(): Promise<void> {
    if (!canCreate) return
    setCreating(true)
    const result = await onCreate(trimmedName, newNote.trim())
    setCreating(false)
    if (!result.ok) {
      setCreateError(result.error)
      return
    }
    setCreateOpen(false)
    onSelect(trimmedName)
  }

  return (
    <div
      className={cn(
        "@container/browser-bar flex h-10 shrink-0 items-center gap-2 border-b px-2",
        !isDefault && "border-amber-500/40 bg-amber-500/10",
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="xs" aria-label="Switch browser" className="max-w-40" />}
        >
          <StatusDot running={selectedInfo?.running ?? false} />
          <span className="truncate">{selected}</span>
          <ChevronDown data-icon="inline-end" className="opacity-60" />
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" sideOffset={6} className="w-72">
          <DropdownMenuRadioGroup value={selected} onValueChange={(value: string) => onSelect(value)}>
            {sessions.map((session) => {
              const lastUsed = lastUsedLabel(session.lastUsedAt)
              const drivenElsewhere = session.driverSessionId !== null
                && session.driverSessionId !== currentSessionId
              return (
                <DropdownMenuRadioItem key={session.name} value={session.name} className="items-start py-1.5">
                  <StatusDot running={session.running} className="mt-[0.4rem]" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate">{session.name}</span>
                      <span className="sr-only">{session.running ? "running" : "stopped"}</span>
                      {session.isDefault && (
                        <Badge variant="secondary" className="h-4 px-1.5 text-[0.65rem] font-normal">
                          Default
                        </Badge>
                      )}
                      {lastUsed && (
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{lastUsed}</span>
                      )}
                    </span>
                    {drivenElsewhere && (
                      <span className="truncate text-xs text-muted-foreground">
                        driven by another session
                      </span>
                    )}
                  </span>
                </DropdownMenuRadioItem>
              )
            })}
          </DropdownMenuRadioGroup>

          <DropdownMenuSeparator />

          <DropdownMenuItem disabled={busy} onClick={openCreate}>
            <Plus />
            New browser…
          </DropdownMenuItem>

          {!isDefault && (
            <>
              <DropdownMenuItem
                disabled={busy || !selectedInfo?.running}
                onClick={() => onStop(selected)}
              >
                <CircleStop />
                Stop
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                disabled={busy}
                onClick={() => setDeleteTarget(selected)}
              >
                <Trash2 />
                Delete…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <span className="flex-1" />

      {!isDefault && (
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            role="status"
            className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300"
          >
            <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
            {/* Too narrow and only the icon is left, but the words stay in the a11y tree. */}
            <span className="sr-only @sm/browser-bar:not-sr-only @sm/browser-bar:whitespace-nowrap">
              Not the default browser
            </span>
          </span>
          <Button variant="outline" size="xs" onClick={onShowDefault}>
            Show default
          </Button>
        </div>
      )}

      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              size="sm"
              aria-label="Follow agent"
              pressed={followAgent}
              onPressedChange={(pressed) => onToggleFollow(pressed)}
              className="text-muted-foreground data-pressed:text-foreground"
            />
          }
        >
          <Crosshair data-icon="inline-start" />
          <span className="hidden @md/browser-bar:inline">Follow</span>
        </TooltipTrigger>
        <TooltipContent>Switch to whichever browser this session&rsquo;s agent uses</TooltipContent>
      </Tooltip>

      <Button variant="ghost" size="icon-sm" aria-label="Close browser panel" onClick={onClose}>
        <X data-icon="inline-start" />
      </Button>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-sm">
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              void submitCreate()
            }}
          >
            <DialogHeader>
              <DialogTitle>New browser</DialogTitle>
              <DialogDescription>
                A named browser keeps its own cookies and logins, and stays out of the default one.
              </DialogDescription>
            </DialogHeader>

            <FieldGroup className="gap-4">
              <Field data-invalid={Boolean(createMessage)}>
                <FieldLabel htmlFor={nameId}>Name</FieldLabel>
                <Input
                  id={nameId}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="shop"
                  aria-invalid={Boolean(createMessage)}
                  value={newName}
                  onChange={(event) => {
                    setNewName(event.target.value)
                    setCreateError(null)
                  }}
                />
                <FieldError>{createMessage}</FieldError>
              </Field>
              <Field>
                <FieldLabel htmlFor={noteId}>
                  Note <span className="text-muted-foreground/60">(optional)</span>
                </FieldLabel>
                <Input
                  id={noteId}
                  autoComplete="off"
                  placeholder="What this browser is signed in to"
                  value={newNote}
                  onChange={(event) => setNewNote(event.target.value)}
                />
              </Field>
            </FieldGroup>

            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
              <Button type="submit" disabled={!canCreate}>Create browser</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {deleteTarget !== null && (
        <AlertDialog
          open
          onOpenChange={(next) => {
            if (!next) setDeleteTarget(null)
          }}
        >
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogMedia className="bg-destructive/10 text-destructive">
                <Trash2 />
              </AlertDialogMedia>
              <AlertDialogTitle>Delete {deleteTarget}?</AlertDialogTitle>
              <AlertDialogDescription>
                Its profile goes with it, so everything signed in there is signed out. Other
                browsers are untouched.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                size="sm"
                onClick={() => {
                  onRemove(deleteTarget)
                  setDeleteTarget(null)
                }}
              >
                Delete browser
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
})
