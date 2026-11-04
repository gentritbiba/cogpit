import { FolderSearch, Loader2, Plus } from "lucide-react"

import { ProjectSwitcherList, useProjectList } from "@/components/ProjectSwitcherList"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { AgentKind } from "@/lib/agents"
import { openFolderBrowser } from "@/lib/folders"
import { shortcutLabel } from "@/lib/keybindings"

/** The project the sidebar is focused on, which New session starts in at once. */
export interface NewSessionProject {
  dirName: string
  cwd?: string
  label: string
}

interface NewSessionButtonProps {
  /** Null when the sidebar lists every project: the button then asks which one. */
  project: NewSessionProject | null
  onNewSession: (dirName: string, cwd?: string) => void
  onNewFolder: (cwd: string) => void
  defaultAgentKind: AgentKind
  creatingSession?: boolean
  /** The project picker's open state, held by the list so its empty state can open it too. */
  pickerOpen: boolean
  onPickerOpenChange: (open: boolean) => void
}

function NewLabel({ creatingSession }: { creatingSession?: boolean }) {
  return (
    <>
      {creatingSession
        ? <Loader2 data-icon="inline-start" className="animate-spin" />
        : <Plus data-icon="inline-start" />}
      New
    </>
  )
}

/**
 * The sidebar's New session control. Focused on a project, it starts there,
 * and a folder icon beside it reaches any other folder. Across every project
 * it opens the same project picker as the new-session shortcut, newest
 * project first, with the folder browser at its foot.
 */
export function NewSessionButton({
  project,
  onNewSession,
  onNewFolder,
  defaultAgentKind,
  creatingSession,
  pickerOpen,
  onPickerOpenChange,
}: NewSessionButtonProps) {
  const projects = useProjectList(pickerOpen)

  if (project) {
    const label = `New session in ${project.label}`
    return (
      <>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="shrink-0"
          disabled={creatingSession}
          onClick={() => onNewSession(project.dirName, project.cwd)}
          aria-label={label}
          title={label}
        >
          <NewLabel creatingSession={creatingSession} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          disabled={creatingSession}
          onClick={() => openFolderBrowser()}
          aria-label="New session in another folder"
          title="New session in another folder"
        >
          <FolderSearch data-icon="inline-start" />
        </Button>
      </>
    )
  }

  const choose = (start: () => void) => {
    onPickerOpenChange(false)
    start()
  }
  return (
    <Popover open={pickerOpen} onOpenChange={onPickerOpenChange}>
      <PopoverTrigger
        render={<Button type="button" variant="outline" size="xs" className="shrink-0" />}
        disabled={creatingSession}
        aria-label="New session"
        title={`Start a new session (${shortcutLabel("newSession")})`}
      >
        <NewLabel creatingSession={creatingSession} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 max-w-[calc(100vw-2rem)] p-0">
        <ProjectSwitcherList
          projects={projects}
          defaultAgentKind={defaultAgentKind}
          onNewSession={(dirName, cwd) => choose(() => onNewSession(dirName, cwd))}
          onNewFolder={(cwd) => choose(() => onNewFolder(cwd))}
        />
      </PopoverContent>
    </Popover>
  )
}
