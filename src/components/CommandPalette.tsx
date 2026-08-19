import { type ComponentType } from "react"
import { Autocomplete } from "@base-ui/react/autocomplete"
import {
  BarChart3,
  ChevronsDownUp,
  ChevronsUpDown,
  Code2,
  Copy,
  CopyPlus,
  FileCode2,
  FolderOpen,
  FolderSearch,
  FolderTree,
  GitBranch,
  Globe2,
  Home,
  Keyboard,
  Laptop,
  LayoutGrid,
  MessageSquare,
  PanelLeft,
  Palette,
  Plus,
  Search,
  Server,
  Settings,
  Settings2,
  Skull,
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
import { DEVICE_SWITCH_COMMANDS, shortcutLabel } from "@/lib/keybindings"

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

export interface CommandPaletteDevice {
  id: string
  name: string
  isLocal: boolean
  isActive: boolean
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
  onToggleMissionControl: () => void
  onDuplicateSession?: () => void
  onCopyResumeCommand?: () => void
  onFindInConversation?: () => void
  onKillAll?: () => void
  onOpenConfig?: () => void
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
  onOpenDevices?: (mode: "add" | "manage") => void
  onSwitchDevice?: (deviceId: string) => void
  onFocusComposer: () => void
  onExpandAll: () => void
  onExpandToolPayloads: () => void
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
  showMission: boolean
  showProjectFiles?: boolean
  projects?: CommandPaletteProject[]
  recentSessions?: CommandPaletteSession[]
  devices?: CommandPaletteDevice[]
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

/**
 * Keeps the entries the current session can actually run, in listed order, so
 * the source order and the on-screen order stay the same thing.
 */
function availableActions(...items: (PaletteAction | false | undefined)[]): PaletteAction[] {
  return items.filter((item): item is PaletteAction => item !== false && item !== undefined)
}

export function CommandPalette(props: CommandPaletteProps) {
  const navigation = availableActions(
    action("home", "Go to dashboard", "home overview", Home, props.onGoHome),
    action(
      "mission-control",
      props.showMission ? "Exit Mission Control" : "Open Mission Control",
      "live sessions blocked waiting answer everything at once",
      LayoutGrid,
      props.onToggleMissionControl,
      shortcutLabel("missionControl"),
    ),
    action(
      "new-session",
      "Start a new session",
      "project agent chat create",
      Plus,
      props.onNewSession,
      shortcutLabel("newSession"),
    ),
    props.onDuplicateSession && action(
      "duplicate-session",
      "Duplicate this session",
      "copy fork clone branch thread",
      CopyPlus,
      props.onDuplicateSession,
    ),
    props.canFocusComposer && action(
      "focus-composer",
      "Focus message composer",
      "chat prompt input",
      MessageSquare,
      props.onFocusComposer,
      shortcutLabel("focusComposer"),
    ),
    props.onFindInConversation && action(
      "find-in-conversation",
      "Find in conversation",
      "search text transcript turns matches",
      Search,
      props.onFindInConversation,
      shortcutLabel("findInConversation"),
    ),
  )

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

  // Only worth its own group once a remote device exists — a single-machine
  // install has nothing to switch between.
  const deviceList = props.devices ?? []
  const devices = deviceList.length > 1 && props.onSwitchDevice
    ? deviceList.slice(0, DEVICE_SWITCH_COMMANDS.length).map((device, index) =>
        action(
          `device-${device.id}`,
          device.isActive ? `${device.name} (current)` : `Switch to ${device.name}`,
          `device machine host remote ${device.id}`,
          device.isLocal ? Laptop : Server,
          () => props.onSwitchDevice?.(device.id),
          shortcutLabel(DEVICE_SWITCH_COMMANDS[index]),
        ),
      )
    : []

  const view = availableActions(
    action(
      "toggle-sidebar",
      props.showSidebar ? "Hide session sidebar" : "Show session sidebar",
      "projects navigation panel",
      PanelLeft,
      props.onToggleSidebar,
      shortcutLabel("toggleSidebar"),
    ),
    props.hasSession && action(
      "toggle-stats",
      props.showStats ? "Hide session analytics" : "Show session analytics",
      "stats tokens usage panel",
      BarChart3,
      props.onToggleStats,
      shortcutLabel("toggleStats"),
    ),
    props.onToggleProjectFiles && action(
      "project-files",
      props.showProjectFiles ? "Close project files" : "Open project files",
      "browse edit save workspace source code",
      FolderTree,
      props.onToggleProjectFiles,
      shortcutLabel("projectFiles"),
    ),
    props.hasFileChanges && action(
      "toggle-file-changes",
      props.showFileChanges ? "Hide file changes" : "Show file changes",
      "diff edits review panel",
      FileCode2,
      props.onToggleFileChanges,
    ),
    props.supportsWorktrees && props.canOpenTerminal && action(
      "toggle-worktrees",
      props.showWorktrees ? "Hide worktrees" : "Show worktrees",
      "git branches panel",
      GitBranch,
      props.onToggleWorktrees,
    ),
  )

  const tools = availableActions(
    props.onOpenProjectInEditor && action(
      "open-project-editor",
      "Open project in editor",
      "code cursor vscode zed workspace",
      Code2,
      props.onOpenProjectInEditor,
    ),
    props.onRevealProject && action(
      "reveal-project",
      "Reveal project in file manager",
      "finder explorer folder directory",
      FolderSearch,
      props.onRevealProject,
    ),
    props.onCopyResumeCommand && action(
      "copy-resume-command",
      "Copy resume command",
      "cli claude codex terminal clipboard continue session",
      Copy,
      props.onCopyResumeCommand,
    ),
    props.onCopyProjectPath && action(
      "copy-project-path",
      "Copy project path",
      "workspace directory clipboard",
      Copy,
      props.onCopyProjectPath,
    ),
    props.onOpenIntegratedTerminal && action(
      "integrated-terminal",
      "New integrated terminal",
      "embedded shell command line process panel",
      Terminal,
      props.onOpenIntegratedTerminal,
      shortcutLabel("newIntegratedTerminal"),
    ),
    props.canOpenTerminal && action(
      "terminal",
      "Open in system terminal",
      "external shell command line app",
      TerminalSquare,
      props.onOpenTerminal,
      shortcutLabel("systemTerminal"),
    ),
    props.onTogglePreview && action(
      "preview",
      "Toggle development preview",
      "browser localhost dev server website",
      Globe2,
      props.onTogglePreview,
      shortcutLabel("preview"),
    ),
    props.onOpenKeyboardShortcuts && action(
      "keyboard-shortcuts",
      "Customize keyboard shortcuts",
      "keybindings hotkeys settings",
      Keyboard,
      props.onOpenKeyboardShortcuts,
    ),
    props.onOpenConfig && action(
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
    action("expand", "Expand all groups", "conversation details", ChevronsDownUp, props.onExpandAll, shortcutLabel("expandAll")),
    action("expand-payloads", "Expand all tool payloads", "raw input result diff conversation details", ChevronsDownUp, props.onExpandToolPayloads, shortcutLabel("expandToolPayloads")),
    action("collapse", "Collapse all", "conversation groups payloads details", ChevronsUpDown, props.onCollapseAll),
    props.onKillAll && action(
      "kill-all",
      "Kill all agent processes",
      "stop terminate halt everything runaway",
      Skull,
      props.onKillAll,
    ),
    props.onOpenDevices && action(
      "manage-devices",
      "Manage devices…",
      "remote machines hub hosts edit rename remove switch",
      Settings2,
      () => props.onOpenDevices?.("manage"),
    ),
    props.onOpenDevices && action(
      "add-device",
      "Add device…",
      "remote machine hub host connect pair new",
      Server,
      () => props.onOpenDevices?.("add"),
    ),
  )

  const groups: PaletteGroup[] = [
    { value: "Navigation", items: navigation },
    ...(recentSessions.length > 0 ? [{ value: "Recent sessions", items: recentSessions }] : []),
    ...(projects.length > 0 ? [{ value: "Projects", items: projects }] : []),
    ...(devices.length > 0 ? [{ value: "Devices", items: devices }] : []),
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
