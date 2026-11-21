import { useState, type ReactNode } from "react"
import { ChevronsUpDown, Folder, Layers } from "lucide-react"

import { LiveIndicator } from "@/components/header-shared"
import { ProjectContextMenu } from "@/components/ProjectContextMenu"
import { ProjectFavicon } from "@/components/ProjectFavicon"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

import type { ProjectScopeOption } from "./projectScope"

interface ProjectScopePickerProps {
  options: ProjectScopeOption[]
  /** The focused project's group key, or null for every project. */
  value: string | null
  /** The option behind `value`, or null when it has no listed sessions. */
  focused: ProjectScopeOption | null
  totalSessions: number
  /** Listed sessions that started a crew. */
  crewCount?: number
  onChange: (key: string | null) => void
  onRenameProject?: (dirName: string, name: string) => void
  /** Idle sessions in the focused project that "Archive idle sessions" would hide. */
  archivableCount?: number
  onArchiveIdle?: () => void
  /** Actions beside the picker, such as starting a new session. */
  children?: ReactNode
  /** Layout for the row the picker heads, which on desktop is also the window's drag strip. */
  className?: string
}

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`
}

/** How much of the focused project is live, for the trigger's second line. */
function focusedSummary(focused: ProjectScopeOption | null): string {
  if (!focused) return "No sessions listed"
  const sessions = plural(focused.total, "session")
  const activity = focused.live > 0 ? `${sessions}, ${focused.live} live` : sessions
  const extras = [
    focused.crews > 0 && plural(focused.crews, "crew"),
    focused.worktrees > 0 && plural(focused.worktrees, "worktree"),
  ].filter(Boolean)
  return [activity, ...extras].join(" · ")
}

/** Sessions blocked on the user, as a warning dot and a count. */
function WaitingCount({ count, label, className }: { count: number; label: string; className?: string }) {
  return (
    <span
      className={cn("flex shrink-0 items-center gap-1 font-medium text-warning", className)}
      aria-label={label}
    >
      <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />
      {count}
    </span>
  )
}

/** Sessions blocked on the user in every project but the focused one. */
function waitingElsewhere(options: ProjectScopeOption[], value: string | null): number {
  if (value === null) return 0
  return options.reduce((sum, option) => (option.key === value ? sum : sum + option.needsYou), 0)
}

/**
 * The sidebar's scope, and its one header row: every project, or one of
 * them. Focused, the trigger carries that project's icon and name, and the
 * list beneath narrows to its sessions alone; how much of it is live is the
 * trigger's hover text. Focus hides the attention strip, so the trigger
 * carries a count of sessions waiting in other projects; opening the picker
 * shows which.
 */
export function ProjectScopePicker({
  options,
  value,
  focused,
  totalSessions,
  crewCount = 0,
  onChange,
  onRenameProject,
  archivableCount,
  onArchiveIdle,
  children,
  className,
}: ProjectScopePickerProps) {
  const [open, setOpen] = useState(false)
  const focusedLabel = focused?.customName ?? value
  const summary = value === null
    ? `${plural(options.length, "project")}, ${plural(totalSessions, "session")}${crewCount > 0 ? ` · ${plural(crewCount, "crew")}` : ""}`
    : focusedSummary(focused)
  const elsewhere = waitingElsewhere(options, value)
  const select = (key: string | null) => {
    onChange(key)
    setOpen(false)
  }

  const trigger = (
    <PopoverTrigger
      aria-label={value === null ? "Choose a project to focus on" : `Focused on ${focusedLabel}. Change project`}
      title={summary}
      className="electron-no-drag flex h-8 min-w-0 items-center gap-2 rounded-lg px-2 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent"
    >
      {value === null ? (
        <Layers className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : (
        <ProjectFavicon
          projectPath={focused?.cwd ?? null}
          fallback={<Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
          className="size-4"
        />
      )}
      <span className="truncate text-sm font-medium text-foreground">
        {value === null ? "All projects" : focusedLabel}
      </span>
      {elsewhere > 0 && (
        <WaitingCount
          count={elsewhere}
          label={elsewhere === 1
            ? "1 session in another project is waiting for you"
            : `${elsewhere} sessions in other projects are waiting for you`}
          className="rounded-full border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[11px]"
        />
      )}
      <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </PopoverTrigger>
  )

  return (
    <div className={cn("flex h-12 shrink-0 items-center gap-0.5 px-2", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        {focused && onRenameProject ? (
          <ProjectContextMenu
            projectLabel={focused.key}
            customName={focused.customName}
            className="flex min-w-0"
            archivableCount={archivableCount}
            onArchiveIdle={onArchiveIdle}
            onRename={(name) => onRenameProject(focused.dirName, name)}
          >
            {trigger}
          </ProjectContextMenu>
        ) : trigger}
        <PopoverContent className="w-72 p-0">
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
                      <WaitingCount
                        count={option.needsYou}
                        label={`${plural(option.needsYou, "session")} waiting for you`}
                        className="text-xs"
                      />
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
      <div className="flex-1" />
      {children}
    </div>
  )
}
