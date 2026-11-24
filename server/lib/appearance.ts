import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseThemeId, type ThemeId } from "../../shared/contracts/appearance"
import { writeOwnerOnlyJson } from "../atomicJsonFile"
import { getDataRoot } from "../config"

/**
 * The machine's own theme, kept beside its other data so every computer that
 * opens this machine, directly or through a hub, shows it the same way.
 */
const FILE_NAME = "appearance.local.json"

let cached: { path: string; theme: ThemeId | null } | null = null

function appearancePath(): string {
  return join(getDataRoot(), FILE_NAME)
}

/** The theme someone picked for this machine, or null when nobody has yet. */
export function getHostTheme(): ThemeId | null {
  const path = appearancePath()
  if (cached?.path === path) return cached.theme
  let theme: ThemeId | null = null
  try {
    theme = parseThemeId((JSON.parse(readFileSync(path, "utf-8")) as { theme?: unknown } | null)?.theme)
  } catch {
    // Missing or unreadable: nobody picked a theme for this machine yet.
  }
  cached = { path, theme }
  return theme
}

export async function setHostTheme(theme: ThemeId): Promise<void> {
  const path = appearancePath()
  await writeOwnerOnlyJson(path, { theme })
  cached = { path, theme }
}

export function __resetHostThemeForTest(): void {
  cached = null
}
