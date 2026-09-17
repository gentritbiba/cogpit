import type { MobileTab } from "@/components/MobileNav"

export const MOBILE_TAB_ORDER: readonly MobileTab[] = ["sessions", "chat", "workspace"]

/** Resolve one bounded swipe step, or null when already at that edge. */
export function adjacentMobileTab(
  tabs: readonly MobileTab[],
  current: MobileTab,
  direction: -1 | 1,
): MobileTab | null {
  const index = tabs.indexOf(current)
  if (index === -1) return null
  return tabs[index + direction] ?? null
}
