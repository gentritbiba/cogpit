import { useSyncExternalStore } from "react"
import { can, subscribeCapabilities } from "@/lib/capabilities"
import type { Capabilities } from "../../shared/contracts/team"

/** Reactive renderer capability check that remains correct through React.memo. */
export function useCapability(capability: keyof Capabilities): boolean {
  return useSyncExternalStore(
    subscribeCapabilities,
    () => can(capability),
    () => can(capability),
  )
}
