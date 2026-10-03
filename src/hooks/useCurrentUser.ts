import { useSyncExternalStore } from "react"
import { getAppGate, getCurrentUser, subscribeCapabilities, type CurrentUser } from "@/lib/capabilities"

/** The signed-in user and edition, re-rendering when /api/me settles again. */
export function useCurrentUser(): CurrentUser {
  return useSyncExternalStore(subscribeCapabilities, getCurrentUser, getCurrentUser)
}

/** Why the server keeps the caller out, when the app shows only the gate; else null. */
export function useAppGate(): string | null {
  return useSyncExternalStore(subscribeCapabilities, getAppGate, getAppGate)
}
