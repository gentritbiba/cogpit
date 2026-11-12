/**
 * Whether the user is currently at the desktop, as the desktop shell's
 * presence reports say.
 *
 * Defaults to false so that a headless server — or a desktop shell that never
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
