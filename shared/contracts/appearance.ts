/** Color themes a machine can wear. The renderer's theme list (src/lib/themes.ts) covers exactly these. */
export const THEME_IDS = ["layered", "layered-light", "dark", "oled", "light"] as const

export type ThemeId = (typeof THEME_IDS)[number]

/** GET reads the machine's theme, PUT `{ theme }` sets it. */
export const APPEARANCE_PATH = "/api/appearance"

/** A machine's look, as `GET /api/appearance` and `/api/hello` report it. Null until someone picks a theme. */
export interface HostAppearance {
  theme: ThemeId | null
}

export function parseThemeId(value: unknown): ThemeId | null {
  return THEME_IDS.find((id) => id === value) ?? null
}
