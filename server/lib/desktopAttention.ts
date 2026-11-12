/**
 * Whether the user is currently at the desktop, as reported by the Electron
 * main process.
 *
 * Defaults to false so that a headless server — or an Electron build that never
 * reports — errs toward delivering the notification. Silently withholding one is
 * the worse failure.
 */
let attended = false

export function setDesktopAttention(value: boolean): void {
  attended = value
}

export function isDesktopAttended(): boolean {
  return attended
}
