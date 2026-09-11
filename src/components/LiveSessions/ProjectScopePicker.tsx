import { useState } from "react"
import { ChevronsUpDown, Folder, Layers, Loader2, Plus } from "lucide-react"

import { LiveIndicator } from "@/components/header-shared"
import { ProjectContextMenu } from "@/components/ProjectContextMenu"
import { ProjectFavicon } from "@/components/ProjectFavicon"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

import type { ProjectScopeOption } from "./projectScope"

interface ProjectScopePickerProps {
  options: ProjectScopeOption[]
  /** The focused project's group key, or null for every project. */
  value: string | null
  /** The option behind `value`, or null when it has no listed sessions. */
  focused: ProjectScopeOption | null
  totalSessions: number
  onChange: (key: string | null) => void
  onNewSession?: (dirName: string, cwd?: string) => void
  creatingSession?: boolean
  onRenameProject?: (dirName: string, name: string) => void
  /** Idle sessions in the focused project that "Archive idle sessions" would hide. */
  archivableCount?: number
  onArchiveIdle?: () => void
}

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`
}

/** How much of the focused project is live, for the trigger's second line. */
function focusedSummary(focused: ProjectScopeOption | null): string {
  if (!focused) return "No sessions listed"
  const sessions = plural(focused.total, "session")
  return focused.live > 0 ? `${sessions}, ${focused.live} live` : sessions
}

/**
 * The sidebar's scope: every project, or one of them. Focused, the trigger
 * becomes that project's masthead — its own icon, its name, and how much of
 * it is live — and the list beneath narrows to its sessions alone.
 */
export function ProjectScopePicker({
  options,
  value,
  focused,
  totalSessions,
  onChange,
  onNewSession,
  creatingSession,
  onRenameProject,
  archivableCount = 0,
  onArchiveIdle,
}: ProjectScopePickerProps) {
  const [open, setOpen] = useState(false)
  const focusedLabel = focused?.customName ?? value
  const summary = value === null
    ? `${plural(options.length, "project")}, ${plural(totalSessions, "session")}`
    : focusedSummary(focused)
  const select = (key: string | null) => {
    onChange(key)
    setOpen(false)
  }

  const trigger = (
    <PopoverTrigger
      aria-label={value === null ? "Choose a project to focus on" : `Focused on ${focusedLabel}. Change project`}
      className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent"
    >
      {value === null ? (
        <Layers className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : (
        <ProjectFavicon
          projectPath={focused?.cwd ?? null}
          fallback={<Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
          className="size-5"
        />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium leading-tight text-foreground">
          {value === null ? "All projects" : focusedLabel}
        </span>
        <span className="truncate text-[11px] leading-tight text-muted-foreground">
          {summary}
        </span>
      </span>
      <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </PopoverTrigger>
  )

  return (
    <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        {focused && onRenameProject ? (
          <ProjectContextMenu
            projectLabel={focused.key}
            customName={focused.customName}
            className="flex min-w-0 flex-1"
            archivableCount={archivableCount}
            onArchiveIdle={onArchiveIdle}
            onRename={(name) => onRenameProject(focused.dirName, name)}
          >
            {trigger}
          </ProjectContextMenu>
        ) : trigger}
        <PopoverContent className="w-(--anchor-width) min-w-72 p-0">
          <Command>
            <CommandInput placeholder="Find a project" autoFocus />
            <CommandList>
              <CommandEmpty>No project matches.</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  value="all-projects"
                  data-checked={value === null}
                  onSelect={() => select(null)}
                  className="gap-2.5"
                >
                  <Layers className="text-muted-foreground" aria-hidden="true" />
                  <span className="flex-1 truncate">All projects</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{totalSessions}</span>
                </CommandItem>
              </CommandGroup>
              <CommandGroup heading="Projects">
                {options.map((option) => (
                  <CommandItem
                    key={option.key}
                    value={option.key}
                    keywords={option.customName ? [option.customName] : undefined}
                    data-checked={value === option.key}
                    onSelect={() => select(option.key)}
                    className="gap-2.5"
                  >
                    <ProjectFavicon
                      projectPath={option.cwd ?? null}
                      fallback={<Folder className="text-muted-foreground" aria-hidden="true" />}
                      className="size-4"
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{option.customName ?? option.key}</span>
                      {option.customName && (
                        <span className="truncate text-[11px] text-muted-foreground">{option.key}</span>
                      )}
                    </span>
                    {option.needsYou > 0 && (
                      <span
                        className="flex shrink-0 items-center gap-1 text-xs font-medium text-warning"
                        aria-label={`${plural(option.needsYou, "session")} waiting for you`}
                      >
                        <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />
                        {option.needsYou}
                      </span>
                    )}
                    {option.live > 0 && (
                      <span
                        className="flex shrink-0 items-center gap-1 text-xs font-medium text-success"
                        aria-label={plural(option.live, "live session")}
                      >
                        <LiveIndicator className="size-1.5" aria-hidden="true" />
                        {option.live}
                      </span>
                    )}
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{option.total}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {focused && onNewSession && (
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className="shrink-0"
          disabled={creatingSession}
          onClick={() => onNewSession(focused.dirName, focused.cwd)}
          aria-label={`New session in ${focusedLabel}`}
        >
          {creatingSession ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <Plus data-icon="inline-start" />
          )}
        </Button>
      )}
    </div>
  )
}
