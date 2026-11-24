import { useMemo, useSyncExternalStore } from "react"
import { can, getCurrentUser, subscribeCapabilities, type CurrentUser } from "@/lib/capabilities"
import type { EditionIdentity, EditionMainView, EditionUi } from "./contract"
import { editionUi, editionUiState, subscribeEditionUi } from "./registry"
import { useDeviceId } from "@/contexts/DevicePaneContext"
import { deviceScope } from "@/lib/device"

const NO_MAIN_VIEWS: readonly EditionMainView[] = []

/** One identity per identity the capability store holds and machine, so a snapshot stays stable until it changes. */
const identities = new WeakMap<CurrentUser, Map<string, EditionIdentity>>()

function editionIdentity(scope: string): EditionIdentity {
  const current = getCurrentUser(scope)
  let byScope = identities.get(current)
  if (!byScope) {
    byScope = new Map()
    identities.set(current, byScope)
  }
  let identity = byScope.get(scope)
  if (!identity) {
    identity = { ...current, can: (capability) => can(capability, scope) }
    byScope.set(scope, identity)
  }
  return identity
}

/** The installed edition's slots; personal edition's empty set until one is installed. */
export function useEditionUi(): EditionUi {
  return useSyncExternalStore(subscribeEditionUi, editionUi, editionUi)
}

function editionUiUnavailable(): boolean {
  return editionUiState() === "unavailable"
}

/** Whether a server reported an edition this build has no UI for, so the app runs on personal defaults. */
export function useEditionUiUnavailable(): boolean {
  return useSyncExternalStore(subscribeEditionUi, editionUiUnavailable, editionUiUnavailable)
}

/** This subtree's machine's identity, as a slot's pure functions read it. */
export function useEditionIdentity(): EditionIdentity {
  const scope = deviceScope(useDeviceId())
  const read = () => editionIdentity(scope)
  return useSyncExternalStore(subscribeCapabilities, read, read)
}

/** The installed edition's main views that the active identity may open. */
export function useMainViews(): readonly EditionMainView[] {
  const { mainViews = NO_MAIN_VIEWS } = useEditionUi()
  const identity = useEditionIdentity()
  return useMemo(() => mainViews.filter((view) => view.isAvailable(identity)), [mainViews, identity])
}

/** The main view `id` names, while the active identity may open it; else null. */
export function useMainView(id: string | null): EditionMainView | null {
  const mainViews = useMainViews()
  return id === null ? null : mainViews.find((view) => view.id === id) ?? null
}
