import { useCallback, useSyncExternalStore } from "react"
import { useDeviceId } from "@/contexts/DevicePaneContext"
import { can, capabilitiesVersion, subscribeCapabilities } from "@/lib/capabilities"
import { deviceScope } from "@/lib/device"
import type { Capabilities } from "../../shared/contracts/identity"

type Capability = keyof Capabilities | (string & {})

/** Reactive capability check on this subtree's machine that remains correct through React.memo. */
export function useCapability(capability: Capability): boolean {
  const scope = deviceScope(useDeviceId())
  return useSyncExternalStore(
    subscribeCapabilities,
    () => can(capability, scope),
    () => can(capability, scope),
  )
}

/**
 * `can`, answered for this subtree's machine, for a component that checks
 * several capabilities while rendering. A new function whenever an identity
 * changes, so memoized checks run again.
 */
export function useCan(): (capability: Capability) => boolean {
  const scope = deviceScope(useDeviceId())
  const version = useSyncExternalStore(subscribeCapabilities, capabilitiesVersion, capabilitiesVersion)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version stands for the identities can reads
  return useCallback((capability: Capability) => can(capability, scope), [scope, version])
}
