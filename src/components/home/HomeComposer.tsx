import { useState, type FormEvent, type KeyboardEvent } from "react"
import { FolderOpen, Send } from "lucide-react"
import { ChatInputSettings } from "@/components/ChatInput/ChatInputSettings"
import { ImageDropOverlay, ImageNotice, ImageThumbnails } from "@/components/ChatInput/ImageAttachments"
import { useImageUpload } from "@/components/ChatInput/useImageUpload"
import { ProjectFavicon } from "@/components/ProjectFavicon"
import { ProjectSwitcherList, useProjectList } from "@/components/ProjectSwitcherList"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Textarea } from "@/components/ui/textarea"
import { useModelCapabilities } from "@/hooks/useModelCapabilities"
import { agentKindForDirName, projectDirNameFor, type AgentKind } from "@/lib/agents"
import { projectName } from "@/lib/format"
import { cn } from "@/lib/utils"
import { splitInstanceDirName } from "../../../shared/session/instances"

export interface HomeProject {
  dirName: string
  cwd?: string
  name: string
}

/** The model and effort the next session starts with: the app's own selection, shared with the new-session composer. */
export interface HomeModelControls {
  selectedModel: string
  onModelChange: (model: string) => void
  selectedEffort: string
  onEffortChange: (effort: string) => void
}

export interface HomeStart {
  defaultAgentKind: AgentKind
  model: HomeModelControls
  /** Start a session in the project and send the message, with any pasted or dropped images, as its first turn. */
  onStart: (dirName: string, cwd: string | undefined, message: string, images?: Array<{ data: string; mediaType: string }>) => void
}

const MAX_CHIPS = 6

/**
 * Where work starts: the projects worked in lately as a row, any other one a
 * picker away, and the composer under them with the model picker inside.
 * Enter sends the first message, and any images pasted or dropped onto it,
 * straight into a new session; the full composer takes over from there.
 */
export function HomeComposer({ recent, start }: { recent: readonly HomeProject[]; start: HomeStart }) {
  const [picked, setPicked] = useState<HomeProject | null>(null)
  const [text, setText] = useState("")
  const project = picked ?? recent[0] ?? null
  const chips = (picked && !recent.some((candidate) => sameFolder(candidate, picked)) ? [picked, ...recent] : [...recent]).slice(0, MAX_CHIPS)
  const message = text.trim()
  const agentKind = project ? agentKindForDirName(project.dirName) : start.defaultAgentKind
  const { imageInput } = useModelCapabilities(agentKind, start.model.selectedModel, splitInstanceDirName(project?.dirName).instanceId)
  const { images, uploading, isDragOver, imageError, hasUnsupportedAttachments, dismissImageError, removeImage, clearImages, handleDragOver, handleDragLeave, handleDrop, handlePaste } = useImageUpload(imageInput)
  const canStart = Boolean(project && (message || images.length > 0)) && !uploading && !hasUnsupportedAttachments

  const choose = (dirName: string, cwd?: string) => {
    setPicked({ dirName, cwd, name: cwd ? projectName(cwd) : dirName })
  }
  const chooseFolder = (cwd: string) => choose(projectDirNameFor(start.defaultAgentKind, cwd), cwd)
  /** The same folder under another agent; a folder the app cannot name has no agent to switch. */
  const cwd = project?.cwd
  const switchAgent = project && cwd
    ? (kind: AgentKind) => setPicked({ ...project, dirName: projectDirNameFor(kind, cwd) })
    : undefined
  // Sessions reorder as they work, so the project selected when the message was begun is the one it goes to.
  const holdProject = () => {
    if (!picked && project) setPicked(project)
  }
  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    if (!project || !canStart) return
    start.onStart(project.dirName, project.cwd, message, images.length > 0 ? images.map(({ data, mediaType }) => ({ data, mediaType })) : undefined)
    setText("")
    clearImages()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <section aria-label="Start a session" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Projects">
        {chips.map((candidate) => {
          const selected = project !== null && sameFolder(candidate, project)
          return (
            <button
              key={candidate.cwd ?? candidate.dirName}
              type="button"
              aria-pressed={selected}
              title={candidate.cwd ?? candidate.name}
              onClick={() => setPicked(candidate)}
              className={cn(
                "flex max-w-48 items-center gap-1.5 rounded-full border py-1 pl-1.5 pr-3 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "border-foreground/80 bg-foreground text-background"
                  : "border-border/70 text-muted-foreground hover:border-foreground/40 hover:text-foreground",
              )}
            >
              <ProjectFavicon projectPath={candidate.cwd ?? null} fallback={<FolderOpen className="size-3.5" aria-hidden="true" />} className="size-4" />
              <span className="truncate">{candidate.name}</span>
            </button>
          )
        })}
        <ProjectPicker defaultAgentKind={start.defaultAgentKind} onChoose={choose} onChooseFolder={chooseFolder} anyListed={chips.length > 0} />
      </div>
      <form
        onSubmit={submit}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(event) => { holdProject(); handleDrop(event) }}
        className="relative min-w-0"
      >
        {isDragOver && <ImageDropOverlay />}
        <ImageThumbnails images={images} onRemove={(_, index) => removeImage(index)} />
        <ImageNotice message={imageError} onDismiss={hasUnsupportedAttachments ? undefined : dismissImageError} />
        <div className="flex items-end gap-2 rounded-xl border bg-popover py-2 pl-4 pr-2 shadow-lg shadow-black/5 transition-[border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
          <Textarea
            aria-label="First message"
            value={text}
            onChange={(event) => {
              holdProject()
              setText(event.target.value)
            }}
            onPaste={(event) => { holdProject(); handlePaste(event) }}
            onKeyDown={onKeyDown}
            placeholder={project ? `Describe the task for ${project.name}` : "Pick a project, then describe the task"}
            rows={1}
            className="max-h-48 min-h-9 flex-1 resize-none rounded-none border-0 bg-transparent px-0 py-2 shadow-none focus-visible:border-transparent focus-visible:ring-0"
          />
          <div className="flex shrink-0 items-center gap-1 pb-0.5">
            {project && (
              <ChatInputSettings
                isNewSession
                agentKind={agentKind}
                onAgentKindChange={switchAgent}
                selectedModel={start.model.selectedModel}
                onModelChange={start.model.onModelChange}
                selectedEffort={start.model.selectedEffort}
                onEffortChange={start.model.onEffortChange}
              />
            )}
            <Button type="submit" size="icon-xs" disabled={!canStart} aria-label="Start session" title="Start session (Enter)">
              <Send data-icon="icon" />
            </Button>
          </div>
        </div>
      </form>
    </section>
  )
}

/** One folder is one project however many agents encode it. */
function sameFolder(a: HomeProject, b: HomeProject): boolean {
  return a.cwd && b.cwd ? a.cwd === b.cwd : a.dirName === b.dirName
}

/** Every project the server knows, and the folder browser behind it, for a project the row does not show. */
function ProjectPicker({
  defaultAgentKind,
  onChoose,
  onChooseFolder,
  anyListed,
}: {
  defaultAgentKind: AgentKind
  onChoose: (dirName: string, cwd?: string) => void
  onChooseFolder: (cwd: string) => void
  anyListed: boolean
}) {
  const [open, setOpen] = useState(false)
  const projects = useProjectList(open)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant={anyListed ? "ghost" : "outline"} size="xs" className="rounded-full text-muted-foreground" />}>
        <FolderOpen data-icon="inline-start" />
        {anyListed ? "Other project" : "Choose a project"}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 max-w-[calc(100vw-2rem)] p-0">
        <ProjectSwitcherList
          projects={projects}
          defaultAgentKind={defaultAgentKind}
          onNewSession={(dirName, cwd) => { setOpen(false); onChoose(dirName, cwd) }}
          onNewFolder={(cwd) => { setOpen(false); onChooseFolder(cwd) }}
        />
      </PopoverContent>
    </Popover>
  )
}
