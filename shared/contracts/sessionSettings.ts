/**
 * The settings a session's stored config keeps for the turns it runs, by the
 * names `/api/session-config` stores them under. A send may carry each of
 * them; an edition may hold a send to the stored value unless it lists the
 * field in `settingsChange`, its caller's deliberate change. A permission mode it
 * carries always counts as one: clients send it only when their user picked it.
 */
export const SESSION_SETTING_FIELDS = [
  "permissionMode",
  "model",
  "effort",
  "contextWindowTokens",
  "fastMode",
  "ultracode",
] as const

export type SessionSettingField = (typeof SESSION_SETTING_FIELDS)[number]

export function isSessionSettingField(value: unknown): value is SessionSettingField {
  return SESSION_SETTING_FIELDS.some((field) => field === value)
}

/** A body's `settingsChange`, absent meaning none; null when it is not a list of session settings. */
export function parseSettingsChange(value: unknown): SessionSettingField[] | null {
  const named = value ?? []
  return Array.isArray(named) && named.every(isSessionSettingField) ? named : null
}
