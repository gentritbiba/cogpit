import { useSyncExternalStore } from "react"
import { useDeviceId } from "@/contexts/DevicePaneContext"
import { getAppGate, getCurrentUser, subscribeCapabilities, type CurrentUser } from "@/lib/capabilities"
import { deviceScope } from "@/lib/device"

/** The signed-in user and edition on this subtree's machine, re-rendering when /api/me settles again. */
export function useCurrentUser(): CurrentUser {
  const scope = deviceScope(useDeviceId())
  const read = () => getCurrentUser(scope)
  return useSyncExternalStore(subscribeCapabilities, read, read)
}

/** Why this subtree's machine keeps the caller out, when the app shows only the gate; else null. */
export function useAppGate(): string | null {
  const scope = deviceScope(useDeviceId())
  const read = () => getAppGate(scope)
  return useSyncExternalStore(subscribeCapabilities, read, read)
}
