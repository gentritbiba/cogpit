import type { MobileTab } from "@/components/MobileNav"

const MOBILE_TAB_ORDER: readonly MobileTab[] = ["sessions", "chat", "stats"]

export interface MobileTabContext {
  hasSession: boolean
  hasPendingSession: boolean
}

/** Return only tabs that have meaningful content in the current app state. */
export function visibleMobileTabs({
  hasSession,
  hasPendingSession,
}: MobileTabContext): MobileTab[] {
  return MOBILE_TAB_ORDER.filter((tab) => {
    if (tab === "stats" && !hasSession && !hasPendingSession) return false
    return true
  })
}

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
