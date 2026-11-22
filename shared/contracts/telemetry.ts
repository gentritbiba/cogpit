/**
 * Anonymous usage data: the features only the renderer sees, which it reports
 * by name. The server owns everything else, and ignores any other name.
 */
export const UI_FEATURES = [
  "command_palette.open",
  "settings.open",
  "keyboard_shortcuts.open",
  "panel.crew",
  "panel.status",
  "panel.worktrees",
  "panel.project_files",
  "panel.browser",
  "panel.library",
  "panel.file_changes",
  "panel.automations",
  "panel.session_info",
] as const

export type UiFeature = (typeof UI_FEATURES)[number]

export function isUiFeature(value: unknown): value is UiFeature {
  return typeof value === "string" && (UI_FEATURES as readonly string[]).includes(value)
}
