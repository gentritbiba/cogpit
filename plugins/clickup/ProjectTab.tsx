import { useEffect, useState, type FormEvent } from "react"
import { Link2, Unlink } from "lucide-react"
import {
  parseClickUpListId,
  type ClickUpListOption,
  type ClickUpListTasksResponse,
  type ClickUpSpace,
} from "../../shared/contracts/clickup"
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from "@/plugin-api"
import { fetchClickUpLists, fetchClickUpSpaces, linkClickUpProject, toErrorResponse } from "./clickupStore"
import { locationLabel } from "./filters"
import { TaskList } from "./TaskList"

function listPlaceholder(spaceId: string, lists: ClickUpListOption[] | null): string {
  if (!spaceId) return "Choose a space first"
  return lists === null ? "Loading lists…" : "Choose a list"
}

/** Pick the list this project maps to: paste its URL, or browse space → list. */
export function LinkProject({ projectPath, onLinked }: { projectPath: string; onLinked: () => void }) {
  const [pasted, setPasted] = useState("")
  const [spaces, setSpaces] = useState<ClickUpSpace[] | null>(null)
  const [spaceId, setSpaceId] = useState<string>("")
  const [lists, setLists] = useState<ClickUpListOption[] | null>(null)
  const [listId, setListId] = useState<string>("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchClickUpSpaces()
      .then((response) => { if (!cancelled) setSpaces(response.spaces) })
      .catch((failure: unknown) => { if (!cancelled) setError(toErrorResponse(failure, "Unable to load spaces").error) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!spaceId) return
    let cancelled = false
    setLists(null)
    setListId("")
    fetchClickUpLists(spaceId)
      .then((response) => { if (!cancelled) setLists(response.lists) })
      .catch((failure: unknown) => { if (!cancelled) setError(toErrorResponse(failure, "Unable to load lists").error) })
    return () => { cancelled = true }
  }, [spaceId])

  async function link(candidate: string | null): Promise<void> {
    if (!candidate) {
      setError("Paste a ClickUp list URL such as https://app.clickup.com/…/v/li/901700000000")
      return
    }
    setBusy(true)
    setError(null)
    try {
      await linkClickUpProject(projectPath, candidate)
      onLinked()
    } catch (failure) {
      setError(toErrorResponse(failure, "Unable to link that list").error)
    } finally {
      setBusy(false)
    }
  }

  function submitPasted(event: FormEvent): void {
    event.preventDefault()
    void link(parseClickUpListId(pasted))
  }

  return (
    <div className="flex flex-col gap-4 p-4" aria-label="Link a ClickUp list">
      <div>
        <h3 className="text-sm font-medium">Link this project to a ClickUp list</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Tasks from the linked list show up here, next to the code they belong to.
        </p>
      </div>

      <form className="flex flex-col gap-2" onSubmit={submitPasted}>
        <label className="text-[11px] font-medium text-muted-foreground" htmlFor="clickup-list-url">List URL or id</label>
        <div className="flex gap-2">
          <Input
            id="clickup-list-url"
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            placeholder="https://app.clickup.com/…/v/li/901700000000"
            className="h-8 text-xs"
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" size="sm" disabled={busy || !pasted.trim()}>
            {busy ? <Spinner /> : <Link2 data-icon="inline-start" />}
            Link
          </Button>
        </div>
      </form>

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="h-px flex-1 bg-border" aria-hidden />
        or browse
        <span className="h-px flex-1 bg-border" aria-hidden />
      </div>

      <div className="flex flex-col gap-2">
        <Select value={spaceId} onValueChange={(value) => setSpaceId(value ?? "")}>
          <SelectTrigger className="h-8 text-xs" aria-label="Space" disabled={spaces === null}>
            <SelectValue placeholder={spaces === null ? "Loading spaces…" : "Choose a space"} />
          </SelectTrigger>
          <SelectContent>
            {spaces?.map((space) => (
              <SelectItem key={space.id} value={space.id}>{space.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={listId} onValueChange={(value) => setListId(value ?? "")}>
          <SelectTrigger className="h-8 text-xs" aria-label="List" disabled={!spaceId || lists === null}>
            <SelectValue placeholder={listPlaceholder(spaceId, lists)} />
          </SelectTrigger>
          <SelectContent>
            {lists?.map((list) => (
              <SelectItem key={list.id} value={list.id}>{locationLabel(list.folderName, list.name)}</SelectItem>
            ))}
            {lists?.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">This space has no lists.</p>}
          </SelectContent>
        </Select>
        <Button type="button" size="sm" variant="outline" disabled={busy || !listId} onClick={() => { void link(listId) }}>
          {busy ? <Spinner /> : <Link2 data-icon="inline-start" />}
          Link selected list
        </Button>
      </div>

      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

export function ProjectTab({
  data,
  projectPath,
  composePrompt,
  onUnlinked,
}: {
  data: ClickUpListTasksResponse
  projectPath: string
  composePrompt: ((text: string) => void) | undefined
  onUnlinked: () => void
}) {
  const [busy, setBusy] = useState(false)
  const location = locationLabel(data.list.folderName, data.list.name)

  async function unlink(): Promise<void> {
    setBusy(true)
    try {
      await linkClickUpProject(projectPath, null)
      onUnlinked()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3 text-[11px] text-muted-foreground">
        <a
          href={data.list.url}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 flex-1 truncate outline-none hover:text-foreground focus-visible:underline"
          title={location}
        >
          {location}
        </a>
        <Button type="button" variant="ghost" size="xs" onClick={() => { void unlink() }} disabled={busy} aria-label="Unlink this project from ClickUp">
          {busy ? <Spinner /> : <Unlink data-icon="inline-start" />}
          Unlink
        </Button>
      </div>
      <TaskList
        tasks={data.tasks}
        viewer={data.viewer}
        composePrompt={composePrompt}
        emptyTitle="No tasks in this list"
        emptyDescription="Tasks added to the linked list will show up here."
        truncated={data.truncated}
      />
    </>
  )
}
