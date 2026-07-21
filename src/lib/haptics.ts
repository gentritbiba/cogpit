/**
 * Haptic feedback utility for mobile devices.
 * Uses the Web Vibration API — degrades gracefully on unsupported platforms.
 */

const canVibrate = typeof navigator !== "undefined" && "vibrate" in navigator

/** Light tap — tab switches, toggles */
export function hapticLight(): void {
  if (canVibrate) navigator.vibrate(10)
}

/** Medium tap — button presses, selections */
export function hapticMedium(): void {
  if (canVibrate) navigator.vibrate(20)
}
