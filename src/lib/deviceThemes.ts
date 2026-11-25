// ── Each machine's theme, as this browser last saw it ──────────────────────
//
// A machine keeps its own theme (GET/PUT /api/appearance). This browser
// remembers what each one wore so the first paint, a background pane and the
// swipe between machines show the right colors before any request returns.
// Kept free of React so the pre-paint bootstrap (theme-bootstrap.ts) can use it.

import { parseThemeId, type ThemeId } from "../../shared/contracts/appearance"
import { DEFAULT_THEME, legacyTheme } from "./themes"

/**
 * Where a machine's theme comes from: the machine itself, or a pick only this
 * browser keeps because the machine is too old to keep one ("unsupported") or
 * the account may not change it ("forbidden").
 */
export type ThemeSource = "host" | "unsupported" | "forbidden"

interface Entry {
  theme: ThemeId
  local?: Exclude<ThemeSource, "host">
}

const STORAGE_KEY = "cogpit-device-themes"

let entries: Record<string, Entry> = load()
const previews = new Map<string, ThemeId>()
const listeners = new Set<() => void>()

function load(): Record<string, Entry> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, { theme?: unknown; local?: unknown }>
    const loaded: Record<string, Entry> = {}
    for (const [deviceId, value] of Object.entries(parsed ?? {})) {
      const theme = parseThemeId(value?.theme)
      const local = value?.local === "unsupported" || value?.local === "forbidden" ? value.local : undefined
      if (theme) loaded[deviceId] = local ? { theme, local } : { theme }
    }
    return loaded
  } catch {
    return {}
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // The theme still applies for this visit without storage.
  }
}

function publish(): void {
  for (const listener of listeners) listener()
}

/** The theme a machine wears, as far as this browser knows. */
export function savedDeviceTheme(deviceId: string): ThemeId {
  return entries[deviceId]?.theme ?? legacyTheme() ?? DEFAULT_THEME
}

/** What the machine's UI shows right now: a theme being previewed, else its saved one. */
export function shownDeviceTheme(deviceId: string): ThemeId {
  return previews.get(deviceId) ?? savedDeviceTheme(deviceId)
}

/** Whether this browser has learned anything about the machine's theme yet. */
export function knowsDeviceTheme(deviceId: string): boolean {
  return entries[deviceId] !== undefined
}

/** A theme picked here for a machine that could not keep it, offered to it again once it can. */
export function localOnlyDeviceTheme(deviceId: string): ThemeId | null {
  const entry = entries[deviceId]
  return entry?.local ? entry.theme : null
}

/** Whether this browser wears its own pick on a machine whose theme the account may not change. */
export function keepsOwnDeviceTheme(deviceId: string): boolean {
  return entries[deviceId]?.local === "forbidden"
}

/** Record what a machine wears, and where that comes from. */
export function rememberDeviceTheme(deviceId: string, theme: ThemeId, source: ThemeSource): void {
  const next: Entry = source === "host" ? { theme } : { theme, local: source }
  const current = entries[deviceId]
  if (current?.theme === next.theme && current.local === next.local) return
  entries = { ...entries, [deviceId]: next }
  persist()
  publish()
}

/** Show `theme` on a machine's UI without saving it; null ends the preview. */
export function previewDeviceTheme(deviceId: string, theme: ThemeId | null): void {
  if ((previews.get(deviceId) ?? null) === theme) return
  if (theme) previews.set(deviceId, theme)
  else previews.delete(deviceId)
  publish()
}

export function subscribeDeviceThemes(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function __resetDeviceThemesForTest(): void {
  entries = load()
  previews.clear()
  publish()
}
