import { type ComponentType } from "react"
import { Autocomplete } from "@base-ui/react/autocomplete"
import {
  BarChart3,
  ChevronsDownUp,
  ChevronsUpDown,
  Code2,
  Copy,
  FileCode2,
  FolderOpen,
  FolderSearch,
  FolderTree,
  GitBranch,
  Globe2,
  Home,
  Keyboard,
  MessageSquare,
  PanelLeft,
  Palette,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Terminal,
  TerminalSquare,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { shortcutLabel } from "@/lib/keybindings"

export interface CommandPaletteProject {
  dirName: string
  path: string
  shortName: string
  sessionCount: number
  lastModified: string | null
}

export interface CommandPaletteSession {
  dirName: string
  fileName: string
  sessionId: string
  projectShortName: string
  name?: string
  aiTitle?: string
  slug?: string
  firstUserMessage?: string
  lastUserMessage?: string
  gitBranch?: string
  cwd?: string
  lastModified?: string
}

export interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onGoHome: () => void
  onNewSession: () => void
  onOpenProject?: (dirName: string) => void
  onOpenSession?: (dirName: string, fileName: string) => void
  onToggleSidebar: () => void
  onToggleStats: () => void
  onToggleFileChanges: () => void
  onToggleWorktrees: () => void
  onOpenConfig: () => void
  onOpenSettings: () => void
  onOpenKeyboardShortcuts?: () => void
  onTogglePreview?: () => void
  onToggleProjectFiles?: () => void
  onOpenTheme: () => void
  onOpenTerminal: () => void
  onOpenIntegratedTerminal?: () => void
  onOpenProjectInEditor?: () => void
  onRevealProject?: () => void
  onCopyProjectPath?: () => void
  onFocusComposer: () => void
  onExpandAll: () => void
  onCollapseAll: () => void
  canFocusComposer: boolean
  canOpenTerminal: boolean
  hasSession: boolean
  hasFileChanges: boolean
  supportsWorktrees: boolean
  showSidebar: boolean
  showStats: boolean
  showFileChanges: boolean
  showWorktrees: boolean
  showConfig: boolean
  showProjectFiles?: boolean
  projects?: CommandPaletteProject[]
  recentSessions?: CommandPaletteSession[]
  loadingNavigation?: boolean
}

interface PaletteAction {
  id: string
  value: string
  label: string
  description?: string
  shortcut?: string
  icon: ComponentType
  run: () => void
}

interface PaletteGroup {
  value: string
  items: PaletteAction[]
}

function action(
  id: string,
  label: string,
  keywords: string,
  icon: ComponentType,
  run: () => void,
  shortcut?: string,
  description?: string,
): PaletteAction {
  return {
    id,
    label,
    icon,
    run,
    shortcut,
    description,
    value: `${label} ${keywords}`,
  }
}

export function CommandPalette(props: CommandPaletteProps) {
  const navigation = [
    action("home", "Go to dashboard", "home overview", Home, props.onGoHome),
    action(
      "new-session",
      "Start a new session",
      "project agent chat create",
      Plus,
      props.onNewSession,
      shortcutLabel("newSession"),
    ),
  ]

  if (props.canFocusComposer) {
    navigation.push(
      action(
        "focus-composer",
        "Focus message composer",
        "chat prompt input",
        MessageSquare,
        props.onFocusComposer,
        "Space",
      ),
    )
  }

  const projects = (props.projects ?? []).slice(0, 8).map((project) =>
    action(
      `project-${project.dirName}`,
      project.shortName,
      `${project.path} ${project.dirName} project workspace`,
      FolderOpen,
      () => props.onOpenProject?.(project.dirName),
      undefined,
      `${project.path} · ${project.sessionCount} session${project.sessionCount === 1 ? "" : "s"}`,
    ),
  )

  const recentSessions = (props.recentSessions ?? []).slice(0, 10).map((session) => {
    const rawLabel = session.aiTitle
      || session.name
      || session.slug
      || session.lastUserMessage
      || session.firstUserMessage
      || session.sessionId
    const label = rawLabel.replace(/\s+/g, " ").trim().slice(0, 160) || session.sessionId
    const details = [session.projectShortName, session.gitBranch].filter(Boolean).join(" · ")
    return action(
      `session-${session.dirName}-${session.fileName}`,
      label,
      `${session.projectShortName} ${session.cwd ?? ""} ${session.gitBranch ?? ""} ${session.sessionId} recent thread conversation`,
      MessageSquare,
      () => props.onOpenSession?.(session.dirName, session.fileName),
      undefined,
      details,
    )
  })

  const view = [
    action(
      "toggle-sidebar",
      props.showSidebar ? "Hide session sidebar" : "Show session sidebar",
      "projects navigation panel",
      PanelLeft,
      props.onToggleSidebar,
      shortcutLabel("toggleSidebar"),
    ),
  ]

  if (props.hasSession) {
    view.push(
      action(
        "toggle-stats",
        props.showStats ? "Hide session analytics" : "Show session analytics",
        "stats tokens usage panel",
        BarChart3,
        props.onToggleStats,
        shortcutLabel("toggleStats"),
      ),
    )
  }

  if (props.onToggleProjectFiles) {
    view.push(
      action(
        "project-files",
        props.showProjectFiles ? "Close project files" : "Open project files",
        "browse edit save workspace source code",
        FolderTree,
        props.onToggleProjectFiles,
        shortcutLabel("projectFiles"),
      ),
    )
  }

  if (props.hasFileChanges) {
    view.push(
      action(
        "toggle-file-changes",
        props.showFileChanges ? "Hide file changes" : "Show file changes",
        "diff edits review panel",
        FileCode2,
        props.onToggleFileChanges,
      ),
    )
  }

  if (props.supportsWorktrees && props.canOpenTerminal) {
    view.push(
      action(
        "toggle-worktrees",
        props.showWorktrees ? "Hide worktrees" : "Show worktrees",
        "git branches panel",
        GitBranch,
        props.onToggleWorktrees,
      ),
    )
  }

  const tools = [
    action(
      "config",
      props.showConfig ? "Close agent configuration" : "Open agent configuration",
      "skills commands claude settings files",
      SlidersHorizontal,
      props.onOpenConfig,
    ),
    action("settings", "Open Cogpit settings", "preferences network", Settings, props.onOpenSettings),
    action(
      "theme",
      "Change theme",
      "appearance light dark oled",
      Palette,
      props.onOpenTheme,
      shortcutLabel("themeSelector"),
    ),
    action("expand", "Expand all turns", "conversation details", ChevronsDownUp, props.onExpandAll, shortcutLabel("expandAll")),
    action("collapse", "Collapse all turns", "conversation details", ChevronsUpDown, props.onCollapseAll, shortcutLabel("collapseAll")),
  ]

  if (props.onOpenKeyboardShortcuts) {
    tools.unshift(
      action(
        "keyboard-shortcuts",
        "Customize keyboard shortcuts",
        "keybindings hotkeys settings",
        Keyboard,
        props.onOpenKeyboardShortcuts,
      ),
    )
  }

  if (props.onTogglePreview) {
    tools.unshift(
      action(
        "preview",
        "Toggle development preview",
        "browser localhost dev server website",
        Globe2,
        props.onTogglePreview,
        shortcutLabel("preview"),
      ),
    )
  }

  if (props.canOpenTerminal) {
    tools.unshift(
      action(
        "terminal",
        "Open in system terminal",
        "external shell command line app",
        TerminalSquare,
        props.onOpenTerminal,
        shortcutLabel("systemTerminal"),
      ),
    )
  }

  if (props.onOpenIntegratedTerminal) {
    tools.unshift(
      action(
        "integrated-terminal",
        "New integrated terminal",
        "embedded shell command line process panel",
        Terminal,
        props.onOpenIntegratedTerminal,
        shortcutLabel("newIntegratedTerminal"),
      ),
    )
  }

  if (props.onCopyProjectPath) {
    tools.unshift(
      action(
        "copy-project-path",
        "Copy project path",
        "workspace directory clipboard",
        Copy,
        props.onCopyProjectPath,
      ),
    )
  }

  if (props.onRevealProject) {
    tools.unshift(
      action(
        "reveal-project",
        "Reveal project in file manager",
        "finder explorer folder directory",
        FolderSearch,
        props.onRevealProject,
      ),
    )
  }

  if (props.onOpenProjectInEditor) {
    tools.unshift(
      action(
        "open-project-editor",
        "Open project in editor",
        "code cursor vscode zed workspace",
        Code2,
        props.onOpenProjectInEditor,
      ),
    )
  }

  const groups: PaletteGroup[] = [
    { value: "Navigation", items: navigation },
    ...(recentSessions.length > 0 ? [{ value: "Recent sessions", items: recentSessions }] : []),
    ...(projects.length > 0 ? [{ value: "Projects", items: projects }] : []),
    { value: "View", items: view },
    { value: "Tools", items: tools },
  ]

  function runAction(item: PaletteAction) {
    props.onOpenChange(false)
    item.run()
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="top-[30%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Command palette</DialogTitle>
          <DialogDescription>Search for a Cogpit action to run.</DialogDescription>
        </DialogHeader>

        <Autocomplete.Root
          autoHighlight="always"
          inline
          items={groups}
          itemToStringValue={(item) => item.value}
          keepHighlight
          open
        >
          <div className="flex h-12 items-center gap-2 px-3 [&>svg]:size-4">
            <Search aria-hidden="true" className="shrink-0 text-muted-foreground" />
            <Autocomplete.Input
              aria-label="Search commands"
              autoFocus
              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              placeholder="Search Cogpit actions…"
            />
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {shortcutLabel("commandPalette")}
            </kbd>
          </div>

          <Separator />

          <Autocomplete.Empty className="py-8 text-center text-sm text-muted-foreground">
            No matching actions.
          </Autocomplete.Empty>

          <Autocomplete.List className="max-h-[min(26rem,60vh)] overflow-y-auto p-1 outline-none">
            {(group: PaletteGroup) => (
              <Autocomplete.Group key={group.value} items={group.items} className="py-1">
                <Autocomplete.GroupLabel className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                  {group.value}
                </Autocomplete.GroupLabel>
                <Autocomplete.Collection>
                  {(item: PaletteAction) => {
                    const Icon = item.icon
                    return (
                      <Autocomplete.Item
                        key={item.id}
                        value={item}
                        className="flex min-h-8 cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
                        onClick={() => runAction(item)}
                      >
                        <Icon />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{item.label}</span>
                          {item.description && (
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {item.description}
                            </span>
                          )}
                        </span>
                        {item.shortcut && (
                          <kbd className="font-mono text-[10px] tracking-wide text-muted-foreground">
                            {item.shortcut}
                          </kbd>
                        )}
                      </Autocomplete.Item>
                    )
                  }}
                </Autocomplete.Collection>
              </Autocomplete.Group>
            )}
          </Autocomplete.List>

          <Separator />

          <div className="flex items-center justify-between gap-3 px-3 py-2 text-[11px] text-muted-foreground">
            <span>{props.loadingNavigation ? "Loading projects and sessions…" : "Type to filter actions"}</span>
            <span className="flex items-center gap-2">
              <span>Navigate ↑↓</span>
              <span>Run ↵</span>
            </span>
          </div>
        </Autocomplete.Root>
      </DialogContent>
    </Dialog>
  )
}
