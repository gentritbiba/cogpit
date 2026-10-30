import { useState } from "react"
import { ChevronsUpDown } from "lucide-react"
import { ProjectFavicon } from "@/components/ProjectFavicon"
import { ProjectSwitcherList, useProjectList } from "@/components/ProjectSwitcherList"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { AgentKind } from "@/lib/agents"
import { projectName, shortPath } from "@/lib/format"
import { shortcutLabel } from "@/lib/keybindings"

export interface HeadlineProjectSwitcher {
  onNewSession: (dirName: string, cwd?: string) => void
  onNewFolder: (cwd: string) => void
  defaultAgentKind: AgentKind
}

/**
 * The question a new session opens on.
 *
 * Pairs with a `justify-center` parent so the composer sits in the middle of an
 * empty workspace rather than pinned to the footer. The composer itself stays
 * in its normal slot in the tree, so sending the first message re-lays out the
 * page without remounting the input or dropping focus.
 */
export function NewSessionHeadline({
  projectPath,
  switcher,
}: {
  projectPath: string | null
  switcher: HeadlineProjectSwitcher
}) {
  const name = projectPath ? projectName(projectPath) : null

  return (
    <div className="flex flex-col items-center gap-2 px-4 text-center">
      <h1 className="text-balance text-2xl font-semibold tracking-tight text-foreground">
        {name ? (
          <>
            What should we build in{" "}
            <ProjectNameSwitcher name={name} projectPath={projectPath} switcher={switcher} />
            ?
          </>
        ) : (
          "What should we build?"
        )}
      </h1>
      {projectPath && (
        <p className="font-mono text-xs text-muted-foreground">{shortPath(projectPath)}</p>
      )}
    </div>
  )
}

/**
 * The project name as the picker the new-session shortcut opens, anchored to
 * the word itself: the user reads "in honest-cms?", disagrees, and clicks the
 * name to change the answer.
 */
function ProjectNameSwitcher({
  name,
  projectPath,
  switcher: { onNewSession, onNewFolder, defaultAgentKind },
}: {
  name: string
  projectPath: string | null
  switcher: HeadlineProjectSwitcher
}) {
  const [open, setOpen] = useState(false)
  const projects = useProjectList(open)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        title="Switch project"
        className="group/project -mx-1 inline-flex max-w-full items-center gap-1.5 rounded-lg px-1.5 align-baseline outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent"
      >
        <ProjectFavicon projectPath={projectPath} fallback={null} className="size-5" />
        <span className="truncate underline decoration-dotted decoration-muted-foreground/50 underline-offset-[6px] transition-colors group-hover/project:decoration-foreground/70 group-data-popup-open/project:decoration-foreground/70">
          {name}
        </span>
        <ChevronsUpDown
          className="size-4 shrink-0 text-muted-foreground transition-colors group-hover/project:text-foreground group-data-popup-open/project:text-foreground"
          aria-hidden="true"
        />
      </PopoverTrigger>
      <PopoverContent align="center" className="w-96 max-w-[calc(100vw-2rem)] p-0">
        <ProjectSwitcherList
          projects={projects}
          currentPath={projectPath}
          defaultAgentKind={defaultAgentKind}
          onNewSession={(dirName, cwd) => {
            setOpen(false)
            onNewSession(dirName, cwd)
          }}
          onNewFolder={(cwd) => {
            setOpen(false)
            onNewFolder(cwd)
          }}
        >
          <div className="flex items-center justify-between border-t px-3 py-2 text-[11px] text-muted-foreground">
            <span>Switch where this session starts</span>
            <kbd className="font-mono">{shortcutLabel("newSession")}</kbd>
          </div>
        </ProjectSwitcherList>
      </PopoverContent>
    </Popover>
  )
}
