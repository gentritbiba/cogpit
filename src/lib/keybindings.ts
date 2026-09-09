const DEVICE_INDEXES = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const
type DeviceIndex = (typeof DEVICE_INDEXES)[number]

export type KeybindingCommand =
  | "commandPalette"
  | "keyboardShortcuts"
  | "integratedTerminal"
  | "newIntegratedTerminal"
  | "closeIntegratedTerminal"
  | "expandAll"
  | "expandToolPayloads"
  | "toggleSidebar"
  | "toggleStats"
  | "missionControl"
  | "newSession"
  | "focusComposer"
  | "findInConversation"
  | "nextLiveSession"
  | "prevLiveSession"
  | "recentSessionBack"
  | "recentSessionForward"
  | "themeSelector"
  | "systemTerminal"
  | "preview"
  | "previewRefresh"
  | "previewFocusUrl"
  | "previewZoomIn"
  | "previewZoomOut"
  | "previewResetZoom"
  | "projectFiles"
  | "projectFileSave"
  | `device.switch.${DeviceIndex}`
  | "device.cycle"

export interface KeybindingChord {
  key: string
  modKey?: boolean
  platformChord?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}

export interface DoubleTapModifierShortcut {
  doubleTapModifier: "mod"
}

export type KeybindingShortcut = KeybindingChord | DoubleTapModifierShortcut

/**
 * The only list of shortcut groups. Both the shortcuts dialog and the dashboard
 * cheat sheet render from this, so a new group cannot silently drop its rows.
 */
export const KEYBINDING_GROUPS = ["General", "View", "Tools"] as const

export type KeybindingGroup = (typeof KEYBINDING_GROUPS)[number]

export interface KeybindingDefinition {
  command: KeybindingCommand
  label: string
  description: string
  group: KeybindingGroup
  defaultShortcut: KeybindingShortcut
}

export const KEYBINDING_DEFINITIONS: readonly KeybindingDefinition[] = [
  {
    command: "commandPalette",
    label: "Open command palette",
    description: "Search actions, projects, and recent sessions",
    group: "General",
    defaultShortcut: { key: "k", modKey: true },
  },
  {
    command: "keyboardShortcuts",
    label: "Show keyboard shortcuts",
    description: "Open this reference — only while no text field is focused",
    group: "General",
    defaultShortcut: { key: "?", shiftKey: true },
  },
  {
    command: "newSession",
    label: "Start a new session",
    description: "Open the project picker for a new agent session",
    group: "General",
    defaultShortcut: { key: "n", platformChord: true },
  },
  {
    command: "focusComposer",
    label: "Focus message composer",
    description: "Jump to the chat composer — only while no text field is focused",
    group: "General",
    defaultShortcut: { key: " " },
  },
  {
    command: "prevLiveSession",
    label: "Focus previous live session",
    description: "Move focus up the live session list; press Enter to open",
    group: "General",
    defaultShortcut: { key: "arrowup", modKey: true, shiftKey: true },
  },
  {
    command: "nextLiveSession",
    label: "Focus next live session",
    description: "Move focus down the live session list; press Enter to open",
    group: "General",
    defaultShortcut: { key: "arrowdown", modKey: true, shiftKey: true },
  },
  {
    command: "recentSessionBack",
    label: "Previous recent session",
    description: "Step back through recently opened sessions",
    group: "General",
    defaultShortcut: { key: "tab", ctrlKey: true },
  },
  {
    command: "recentSessionForward",
    label: "Next recent session",
    description: "Step forward through recently opened sessions",
    group: "General",
    defaultShortcut: { key: "tab", ctrlKey: true, shiftKey: true },
  },
  {
    command: "toggleSidebar",
    label: "Toggle session sidebar",
    description: "Show or hide projects and sessions",
    group: "View",
    defaultShortcut: { key: "b", modKey: true },
  },
  {
    command: "missionControl",
    label: "Toggle Mission Control",
    description: "Show every live session at once and answer whatever is blocked",
    group: "View",
    defaultShortcut: { doubleTapModifier: "mod" },
  },
  {
    command: "toggleStats",
    label: "Toggle session analytics",
    description: "Show or hide the right analytics panel",
    group: "View",
    defaultShortcut: { key: "b", modKey: true, shiftKey: true },
  },
  {
    command: "expandAll",
    label: "Expand all groups",
    description: "Expand conversation and tool groups without opening raw payloads",
    group: "View",
    defaultShortcut: { key: "e", modKey: true },
  },
  {
    command: "expandToolPayloads",
    label: "Expand all tool payloads",
    description: "Expand tool inputs, results, and diffs with their containing groups",
    group: "View",
    defaultShortcut: { key: "e", modKey: true, shiftKey: true },
  },
  {
    command: "findInConversation",
    label: "Find in conversation",
    description: "Search the open conversation and step through matches",
    group: "View",
    defaultShortcut: { key: "f", modKey: true },
  },
  {
    command: "integratedTerminal",
    label: "Toggle integrated terminal",
    description: "Open or collapse the in-app project terminal",
    group: "Tools",
    defaultShortcut: { key: "j", modKey: true },
  },
  {
    command: "newIntegratedTerminal",
    label: "New integrated terminal",
    description: "Create another terminal while the integrated terminal is focused",
    group: "Tools",
    defaultShortcut: { key: "n", modKey: true },
  },
  {
    command: "closeIntegratedTerminal",
    label: "Close integrated terminal",
    description: "Close the active terminal while the integrated terminal is focused",
    group: "Tools",
    defaultShortcut: { key: "w", modKey: true },
  },
  {
    command: "preview",
    label: "Toggle development preview",
    description: "Show or hide the in-app local server preview",
    group: "Tools",
    defaultShortcut: { key: "j", modKey: true, shiftKey: true },
  },
  {
    command: "previewRefresh",
    label: "Refresh development preview",
    description: "Reload the page while the preview toolbar is focused",
    group: "Tools",
    defaultShortcut: { key: "r", modKey: true },
  },
  {
    command: "previewFocusUrl",
    label: "Focus preview URL",
    description: "Select the URL while the preview toolbar is focused",
    group: "Tools",
    defaultShortcut: { key: "l", modKey: true },
  },
  {
    command: "previewZoomIn",
    label: "Zoom preview in",
    description: "Increase the preview scale while its toolbar is focused",
    group: "Tools",
    defaultShortcut: { key: "=", modKey: true },
  },
  {
    command: "previewZoomOut",
    label: "Zoom preview out",
    description: "Decrease the preview scale while its toolbar is focused",
    group: "Tools",
    defaultShortcut: { key: "-", modKey: true },
  },
  {
    command: "previewResetZoom",
    label: "Reset preview zoom",
    description: "Return the preview to 100% while its toolbar is focused",
    group: "Tools",
    defaultShortcut: { key: "0", modKey: true },
  },
  {
    command: "projectFiles",
    label: "Toggle project files",
    description: "Browse and edit files in the active project",
    group: "Tools",
    defaultShortcut: { key: "f", modKey: true, shiftKey: true },
  },
  {
    command: "projectFileSave",
    label: "Save project file",
    description: "Save the open file while the project file workspace is focused",
    group: "Tools",
    defaultShortcut: { key: "s", modKey: true },
  },
  {
    command: "systemTerminal",
    label: "Open system terminal",
    description: "Open the project in your preferred terminal app",
    group: "Tools",
    defaultShortcut: { key: "t", platformChord: true },
  },
  {
    command: "themeSelector",
    label: "Change theme",
    description: "Open the theme selector",
    group: "Tools",
    defaultShortcut: { key: "s", platformChord: true },
  },
  // Multi-device switching. 1 = this machine, then remote devices in registry
  // order. mod+1..9 is browser-reserved and mod+shift+1..9 already jumps to the
  // Nth live session, so these use the platform chord (⌃⌘N / Ctrl+Alt+N).
  ...DEVICE_INDEXES.map((n) => ({
    command: `device.switch.${n}` as const,
    label: `Switch to device ${n}`,
    description: n === 1
      ? "Jump to this machine (the local device)"
      : `Jump to the ${n}${n === 2 ? "nd" : n === 3 ? "rd" : "th"} device in the switcher`,
    group: "General" as const,
    defaultShortcut: { key: String(n), platformChord: true },
  })),
  {
    command: "device.cycle",
    label: "Cycle devices",
    description: "Switch to the next device in the switcher",
    group: "General",
    defaultShortcut: { key: "0", platformChord: true },
  },
] as const

const STORAGE_KEY = "cogpit-keybindings"
let cachedOverrides: Partial<Record<KeybindingCommand, KeybindingShortcut>> | null = null

function isMac(platform = typeof navigator === "undefined" ? "" : navigator.platform): boolean {
  return /Mac|iPhone|iPad/i.test(platform)
}

function normalizeKey(key: string): string {
  const normalized = key.toLowerCase()
  if (normalized === "esc") return "escape"
  return normalized
}

function isShortcut(value: unknown): value is KeybindingShortcut {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return candidate.doubleTapModifier === "mod"
    || (typeof candidate.key === "string" && candidate.key.length > 0)
}

function loadOverrides(): Partial<Record<KeybindingCommand, KeybindingShortcut>> {
  if (cachedOverrides) return cachedOverrides
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return (cachedOverrides = {})
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return (cachedOverrides = {})
    const overrides: Partial<Record<KeybindingCommand, KeybindingShortcut>> = {}
    for (const definition of KEYBINDING_DEFINITIONS) {
      const value = (parsed as Record<string, unknown>)[definition.command]
      if (isShortcut(value)) overrides[definition.command] = value
    }
    return (cachedOverrides = overrides)
  } catch {
    return (cachedOverrides = {})
  }
}

function persistOverrides(overrides: Partial<Record<KeybindingCommand, KeybindingShortcut>>) {
  cachedOverrides = overrides
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
  } catch {
    // Storage can be unavailable in private or sandboxed contexts.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("cogpit-keybindings-changed"))
  }
}

export function getKeybinding(command: KeybindingCommand): KeybindingShortcut {
  const definition = KEYBINDING_DEFINITIONS.find((item) => item.command === command)
  if (!definition) throw new Error(`Unknown keybinding command: ${command}`)
  return loadOverrides()[command] ?? definition.defaultShortcut
}

export function getResolvedKeybindings(): Record<KeybindingCommand, KeybindingShortcut> {
  return Object.fromEntries(
    KEYBINDING_DEFINITIONS.map((definition) => [definition.command, getKeybinding(definition.command)]),
  ) as Record<KeybindingCommand, KeybindingShortcut>
}

export function setKeybinding(command: KeybindingCommand, shortcut: KeybindingShortcut) {
  const normalized = "doubleTapModifier" in shortcut
    ? { ...shortcut }
    : { ...shortcut, key: normalizeKey(shortcut.key) }
  persistOverrides({ ...loadOverrides(), [command]: normalized })
}

export function resetKeybinding(command: KeybindingCommand) {
  const overrides = { ...loadOverrides() }
  delete overrides[command]
  persistOverrides(overrides)
}

export function resetAllKeybindings() {
  persistOverrides({})
}

export function shortcutFromKeyboardEvent(event: KeyboardEvent): KeybindingShortcut {
  return {
    key: normalizeKey(event.key),
    metaKey: event.metaKey || undefined,
    ctrlKey: event.ctrlKey || undefined,
    shiftKey: event.shiftKey || undefined,
    altKey: event.altKey || undefined,
  }
}

/**
 * Whether `node` is somewhere the user is typing. Shortcuts bound to bare keys
 * (Space, `?`) must stay inert inside inputs, textareas, and rich-text editors.
 */
export function isEditableTarget(node: EventTarget | null): boolean {
  const element = node as HTMLElement | null
  if (!element) return false
  const tag = element.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || element.isContentEditable === true
}

export function matchesKeybinding(command: KeybindingCommand, event: KeyboardEvent): boolean {
  const shortcut = getKeybinding(command)
  if ("doubleTapModifier" in shortcut) return false
  if (normalizeKey(event.key) !== normalizeKey(shortcut.key)) return false

  if (shortcut.modKey) {
    if (event.metaKey === event.ctrlKey) return false
    return (
      event.shiftKey === Boolean(shortcut.shiftKey)
      && event.altKey === Boolean(shortcut.altKey)
    )
  }

  if (shortcut.platformChord) {
    return (
      event.ctrlKey
      && event.metaKey !== event.altKey
      && event.shiftKey === Boolean(shortcut.shiftKey)
    )
  }

  return (
    event.metaKey === Boolean(shortcut.metaKey)
    && event.ctrlKey === Boolean(shortcut.ctrlKey)
    && event.shiftKey === Boolean(shortcut.shiftKey)
    && event.altKey === Boolean(shortcut.altKey)
  )
}

function formatKey(key: string): string {
  if (key === " ") return "Space"
  if (key === "escape") return "Esc"
  if (key === "tab") return "Tab"
  if (key === "arrowup") return "↑"
  if (key === "arrowdown") return "↓"
  if (key === "arrowleft") return "←"
  if (key === "arrowright") return "→"
  return key.length === 1 ? key.toUpperCase() : key
}

export function formatShortcut(shortcut: KeybindingShortcut): string {
  const mac = isMac()
  if ("doubleTapModifier" in shortcut) {
    return mac ? "Double ⌘" : "Double Ctrl"
  }
  if (shortcut.modKey) {
    return mac
      ? `${shortcut.shiftKey ? "⇧" : ""}⌘${formatKey(shortcut.key)}`
      : `Ctrl+${shortcut.shiftKey ? "Shift+" : ""}${formatKey(shortcut.key)}`
  }
  if (shortcut.platformChord) {
    return mac
      ? `⌃⌘${shortcut.shiftKey ? "⇧" : ""}${formatKey(shortcut.key)}`
      : `Ctrl+Alt+${shortcut.shiftKey ? "Shift+" : ""}${formatKey(shortcut.key)}`
  }

  if (mac) {
    return `${shortcut.ctrlKey ? "⌃" : ""}${shortcut.altKey ? "⌥" : ""}${shortcut.shiftKey ? "⇧" : ""}${shortcut.metaKey ? "⌘" : ""}${formatKey(shortcut.key)}`
  }
  const parts = [
    shortcut.ctrlKey ? "Ctrl" : null,
    shortcut.altKey ? "Alt" : null,
    shortcut.shiftKey ? "Shift" : null,
    shortcut.metaKey ? "Meta" : null,
    formatKey(shortcut.key),
  ].filter(Boolean)
  return parts.join("+")
}

export function shortcutLabel(command: KeybindingCommand): string {
  return formatShortcut(getKeybinding(command))
}

function shortcutSignatures(shortcut: KeybindingShortcut): string[] {
  if ("doubleTapModifier" in shortcut) return [`double-tap:${shortcut.doubleTapModifier}`]
  const signature = (meta: boolean, ctrl: boolean, shift: boolean, alt: boolean) =>
    `${normalizeKey(shortcut.key)}|${meta}|${ctrl}|${shift}|${alt}`
  if (shortcut.modKey) {
    return [
      signature(true, false, Boolean(shortcut.shiftKey), Boolean(shortcut.altKey)),
      signature(false, true, Boolean(shortcut.shiftKey), Boolean(shortcut.altKey)),
    ]
  }
  if (shortcut.platformChord) {
    return [
      signature(true, true, Boolean(shortcut.shiftKey), false),
      signature(false, true, Boolean(shortcut.shiftKey), true),
    ]
  }
  return [signature(
    Boolean(shortcut.metaKey),
    Boolean(shortcut.ctrlKey),
    Boolean(shortcut.shiftKey),
    Boolean(shortcut.altKey),
  )]
}

export function findKeybindingConflict(
  shortcut: KeybindingShortcut,
  except: KeybindingCommand,
): KeybindingDefinition | null {
  const signatures = new Set(shortcutSignatures(shortcut))
  return KEYBINDING_DEFINITIONS.find((definition) =>
    definition.command !== except
    && shortcutSignatures(getKeybinding(definition.command)).some((value) => signatures.has(value)),
  ) ?? null
}

export function getDoubleTapModifierKey(command: KeybindingCommand): "Meta" | "Control" | null {
  const shortcut = getKeybinding(command)
  if (!("doubleTapModifier" in shortcut)) return null
  return isMac() ? "Meta" : "Control"
}

// ── Multi-device switching helpers ───────────────────────────────────────────

/** The nine "switch to device N" commands, ordered 1 → 9. */
export const DEVICE_SWITCH_COMMANDS = DEVICE_INDEXES.map((n) => `device.switch.${n}` as const)

export const DEVICE_CYCLE_COMMAND: KeybindingCommand = "device.cycle"

/**
 * If `event` matches one of the device-switch shortcuts, return its 1-based
 * index (1 = local machine, 2..9 = remote devices in registry order); otherwise
 * null. Intended for the App-level keydown handler that performs the switch —
 * these registry entries have no dispatcher of their own yet.
 */
export function matchDeviceSwitchIndex(event: KeyboardEvent): number | null {
  const index = DEVICE_SWITCH_COMMANDS.findIndex((command) => matchesKeybinding(command, event))
  return index === -1 ? null : index + 1
}

/** Whether `event` matches the "cycle to next device" shortcut. */
export function matchDeviceCycle(event: KeyboardEvent): boolean {
  return matchesKeybinding(DEVICE_CYCLE_COMMAND, event)
}
