import { memo, useId, useState } from "react"
import { CircleStop, Crosshair, Eye, Plus, Sparkles, Trash2, TriangleAlert, X } from "lucide-react"
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
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Toggle } from "@/components/ui/toggle"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { BrowserSessionPicker } from "./BrowserSessionPicker"
import { controlOf } from "./browserSessions"
import { cn } from "@/lib/utils"
import type { BrowserActionResult } from "@/hooks/useBrowserSessions"
import type { BrowserSessionInfo } from "../../../shared/browser/types"

/**
 * Which browser the panel is showing, and everything that changes that: the
 * picker, creating and removing named browsers, following the agent, and the
 * standing reminder when the visible browser is not the caller's default.
 * Each control shows only when the server lets the caller use it.
 */

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/
const NAME_RULE = "Lowercase letters, numbers, - and _, starting with a letter or number (40 max)."

interface BrowserSessionBarProps {
  sessions: BrowserSessionInfo[]
  selected: string
  /** The caller's default browser: their own, or the host's `default`. */
  home: string
  /** This Cogpit session, so a browser another one drives can say so. */
  currentSessionId: string | null
  followAgent: boolean
  /** A browser action is already in flight; the mutating controls stand down. */
  busy?: boolean
  onSelect: (name: string) => void
  onToggleFollow: (next: boolean) => void
  /** Opens the panel's skill dialog; installing is never implicit. */
  onOpenSkill: () => void
  onCreate: (name: string, note: string) => Promise<BrowserActionResult>
  onRemove: (name: string) => void
  onStop: (name: string) => void
  onSetArchived: (name: string, archived: boolean) => Promise<BrowserActionResult>
  onShowDefault: () => void
  onClose: () => void
}

export const BrowserSessionBar = memo(function BrowserSessionBar({
  sessions,
  selected,
  home,
  currentSessionId,
  followAgent,
  busy = false,
  onSelect,
  onToggleFollow,
  onOpenSkill,
  onCreate,
  onRemove,
  onStop,
  onSetArchived,
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

  const isHome = selected === home
  const selectedInfo = sessions.find((session) => session.name === selected) ?? null
  const control = controlOf(selectedInfo)
  const homeIsOwn = sessions.some((session) => session.mine && session.name === home)
  // The host's `default` stays whatever else the caller may do with it.
  const canStop = !isHome && !selectedInfo?.isDefault && control !== "watch"
  const canDelete = !isHome && !selectedInfo?.isDefault && control === "own"

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
        !isHome && "border-amber-500/40 bg-amber-500/10",
      )}
    >
      <BrowserSessionPicker
        sessions={sessions}
        selected={selected}
        home={home}
        currentSessionId={currentSessionId}
        busy={busy}
        onSelect={onSelect}
        onSetArchived={onSetArchived}
      >
        {(close) => <>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { close(); openCreate() }}>
            <Plus data-icon="inline-start" />
            New browser…
          </Button>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="xs" onClick={() => { close(); onOpenSkill() }}>
              <Sparkles data-icon="inline-start" />
              Agent skill…
            </Button>
            {canStop && (
              <Button variant="ghost" size="xs" disabled={busy || !selectedInfo?.running} onClick={() => { close(); onStop(selected) }}>
                <CircleStop data-icon="inline-start" />
                Stop
              </Button>
            )}
            {canDelete && (
              <Button variant="ghost" size="xs" disabled={busy} onClick={() => { close(); setDeleteTarget(selected) }}>
                <Trash2 data-icon="inline-start" />
                Delete…
              </Button>
            )}
          </div>
        </>}
      </BrowserSessionPicker>

      <span className="flex-1" />

      {control === "watch" && (
        <Badge variant="outline" title="Only someone who can interact with the session driving it can use it">
          <Eye data-icon="inline-start" />
          View only
        </Badge>
      )}

      {!isHome && (
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            role="status"
            className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300"
          >
            <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
            {/* Too narrow and only the icon is left, but the words stay in the a11y tree. */}
            <span className="sr-only @sm/browser-bar:not-sr-only @sm/browser-bar:whitespace-nowrap">
              {homeIsOwn ? "Not your browser" : "Not the default browser"}
            </span>
          </span>
          <Button variant="outline" size="xs" onClick={onShowDefault}>
            {homeIsOwn ? "Show yours" : "Show default"}
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
