export type KeybindingCommand =
  | "commandPalette"
  | "integratedTerminal"
  | "newIntegratedTerminal"
  | "closeIntegratedTerminal"
  | "expandAll"
  | "collapseAll"
  | "toggleSidebar"
  | "toggleStats"
  | "newSession"
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
  | "device.switch.1"
  | "device.switch.2"
  | "device.switch.3"
  | "device.switch.4"
  | "device.switch.5"
  | "device.switch.6"
  | "device.switch.7"
  | "device.switch.8"
  | "device.switch.9"
  | "device.cycle"

export interface KeybindingShortcut {
  key: string
  modKey?: boolean
  platformChord?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}

export interface KeybindingDefinition {
  command: KeybindingCommand
  label: string
  description: string
  group: "General" | "View" | "Tools"
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
    command: "newSession",
    label: "Start a new session",
    description: "Open the project picker for a new agent session",
    group: "General",
    defaultShortcut: { key: "n", platformChord: true },
  },
  {
    command: "toggleSidebar",
    label: "Toggle session sidebar",
    description: "Show or hide projects and sessions",
    group: "View",
    defaultShortcut: { key: "b", modKey: true },
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
    label: "Expand all turns",
    description: "Expand every conversation turn",
    group: "View",
    defaultShortcut: { key: "e", modKey: true },
  },
  {
    command: "collapseAll",
    label: "Collapse all turns",
    description: "Collapse every conversation turn",
    group: "View",
    defaultShortcut: { key: "e", modKey: true, shiftKey: true },
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
  // order. (mod+1..9 is browser-reserved, so these use mod+shift.)
  {
    command: "device.switch.1",
    label: "Switch to device 1",
    description: "Jump to this machine (the local device)",
    group: "General",
    defaultShortcut: { key: "1", modKey: true, shiftKey: true },
  },
  {
    command: "device.switch.2",
    label: "Switch to device 2",
    description: "Jump to the 2nd device in the switcher",
    group: "General",
    defaultShortcut: { key: "2", modKey: true, shiftKey: true },
  },
  {
    command: "device.switch.3",
    label: "Switch to device 3",
    description: "Jump to the 3rd device in the switcher",
    group: "General",
    defaultShortcut: { key: "3", modKey: true, shiftKey: true },
  },
  {
    command: "device.switch.4",
    label: "Switch to device 4",
    description: "Jump to the 4th device in the switcher",
    group: "General",
    defaultShortcut: { key: "4", modKey: true, shiftKey: true },
  },
  {
    command: "device.switch.5",
    label: "Switch to device 5",
    description: "Jump to the 5th device in the switcher",
    group: "General",
    defaultShortcut: { key: "5", modKey: true, shiftKey: true },
  },
  {
    command: "device.switch.6",
    label: "Switch to device 6",
    description: "Jump to the 6th device in the switcher",
    group: "General",
    defaultShortcut: { key: "6", modKey: true, shiftKey: true },
  },
  {
    command: "device.switch.7",
    label: "Switch to device 7",
    description: "Jump to the 7th device in the switcher",
    group: "General",
    defaultShortcut: { key: "7", modKey: true, shiftKey: true },
  },
  {
    command: "device.switch.8",
    label: "Switch to device 8",
    description: "Jump to the 8th device in the switcher",
    group: "General",
    defaultShortcut: { key: "8", modKey: true, shiftKey: true },
  },
  {
    command: "device.switch.9",
    label: "Switch to device 9",
    description: "Jump to the 9th device in the switcher",
    group: "General",
    defaultShortcut: { key: "9", modKey: true, shiftKey: true },
  },
  {
    command: "device.cycle",
    label: "Cycle devices",
    description: "Switch to the next device in the switcher",
    group: "General",
    defaultShortcut: { key: "0", modKey: true, shiftKey: true },
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
  return typeof candidate.key === "string" && candidate.key.length > 0
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
  persistOverrides({ ...loadOverrides(), [command]: { ...shortcut, key: normalizeKey(shortcut.key) } })
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

export function matchesKeybinding(command: KeybindingCommand, event: KeyboardEvent): boolean {
  const shortcut = getKeybinding(command)
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
  if (key === "arrowup") return "↑"
  if (key === "arrowdown") return "↓"
  if (key === "arrowleft") return "←"
  if (key === "arrowright") return "→"
  return key.length === 1 ? key.toUpperCase() : key
}

export function formatShortcut(shortcut: KeybindingShortcut): string {
  const mac = isMac()
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

// ── Multi-device switching helpers ───────────────────────────────────────────

/** The nine "switch to device N" commands, ordered 1 → 9. */
export const DEVICE_SWITCH_COMMANDS = [
  "device.switch.1",
  "device.switch.2",
  "device.switch.3",
  "device.switch.4",
  "device.switch.5",
  "device.switch.6",
  "device.switch.7",
  "device.switch.8",
  "device.switch.9",
] as const satisfies readonly KeybindingCommand[]

export const DEVICE_CYCLE_COMMAND: KeybindingCommand = "device.cycle"

/**
 * If `event` matches one of the device-switch shortcuts, return its 1-based
 * index (1 = local machine, 2..9 = remote devices in registry order); otherwise
 * null. Intended for the App-level keydown handler that performs the switch —
 * these registry entries have no dispatcher of their own yet.
 */
export function matchDeviceSwitchIndex(event: KeyboardEvent): number | null {
  for (let index = 0; index < DEVICE_SWITCH_COMMANDS.length; index++) {
    if (matchesKeybinding(DEVICE_SWITCH_COMMANDS[index], event)) return index + 1
  }
  return null
}

/** Whether `event` matches the "cycle to next device" shortcut. */
export function matchDeviceCycle(event: KeyboardEvent): boolean {
  return matchesKeybinding(DEVICE_CYCLE_COMMAND, event)
}
