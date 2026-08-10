import { useState, useEffect, useRef } from "react"
import { authFetch, hubFetch } from "@/lib/auth"
import { setMe } from "@/lib/capabilities"
import { getActiveDeviceId, isRemoteDeviceActive, LOCAL_DEVICE_ID, setActiveIdentity } from "@/lib/device"
import {
  ALL_CAPABILITIES,
  NO_CAPABILITIES,
  type Capabilities,
  type CogpitEdition,
  type MeResponse,
} from "../../shared/contracts/team"

/**
 * Personal-parity fallback used when a known-personal server has no usable
 * /api/me response. Team origins and team targets always fail closed.
 */
const PERSONAL_ME: MeResponse = {
  authenticated: true,
  edition: "personal",
  user: null,
  capabilities: ALL_CAPABILITIES,
}

const UNRESOLVED_ME: MeResponse = {
  authenticated: false,
  edition: "personal",
  user: null,
  capabilities: NO_CAPABILITIES,
}

const CAPABILITY_KEYS = Object.keys(ALL_CAPABILITIES) as (keyof Capabilities)[]

function validMeForEdition(me: MeResponse | null, edition: CogpitEdition): me is MeResponse {
  return me !== null
    && me.edition === edition
    && me.authenticated
    && (edition === "personal" ? me.user === null : me.user !== null)
    && CAPABILITY_KEYS.every((capability) => typeof me.capabilities?.[capability] === "boolean")
}

function intersectCapabilities(outer: Capabilities, target: Capabilities): Capabilities {
  const result = { ...NO_CAPABILITIES }
  for (const capability of CAPABILITY_KEYS) {
    result[capability] = outer[capability] && target[capability]
  }
  return result
}

async function fetchMe(
  fetcher: typeof authFetch,
  signal: AbortSignal,
): Promise<MeResponse | null> {
  try {
    const res = await fetcher("/api/me", { signal })
    if (!res.ok) return null
    return await res.json() as MeResponse
  } catch {
    return null
  }
}

async function fetchTargetEdition(signal: AbortSignal): Promise<CogpitEdition | null> {
  try {
    const res = await authFetch("/api/hello", { signal })
    if (!res.ok) return null
    const data = await res.json() as { edition?: unknown }
    return data.edition === "team" ? "team" : "personal"
  } catch {
    return null
  }
}

export interface MeState extends MeResponse {
  /** True after the current auth identity's /api/me request has settled. */
  checked: boolean
}

/** Mirror an identity into the render-time gate + storage scoping cells. */
function applyMe(me: MeResponse): MeResponse {
  setMe(me)
  setActiveIdentity(me.user?.id ?? null)
  return me
}

/**
 * The signed-in origin identity from `/api/me`, refreshed whenever auth state
 * changes (login/logout). A remote device may narrow its capabilities, but it
 * never replaces the origin user or cache identity.
 */
export function useMe(expectedEdition: CogpitEdition | null): MeState {
  const [me, setMeState] = useState<MeState>({ ...UNRESOLVED_ME, checked: false })
  // Bump to re-fetch the identity (e.g. after login on a gated client)
  const [fetchKey, setFetchKey] = useState(0)
  const activeController = useRef<AbortController | null>(null)
  const preserveIdentityOnNextFetch = useRef(false)

  useEffect(() => {
    activeController.current?.abort()
    if (expectedEdition === null) {
      preserveIdentityOnNextFetch.current = false
      setMe(UNRESOLVED_ME)
      setMeState({ ...UNRESOLVED_ME, checked: false })
      return
    }
    const preserveIdentity = preserveIdentityOnNextFetch.current
    preserveIdentityOnNextFetch.current = false
    setMe(UNRESOLVED_ME)
    setMeState((current) => preserveIdentity
      ? { ...current, capabilities: NO_CAPABILITIES, checked: false }
      : { ...UNRESOLVED_ME, checked: false })
    const controller = new AbortController()
    activeController.current = controller
    const remote = isRemoteDeviceActive()
    const originMe = fetchMe(hubFetch, controller.signal)
    const targetEdition = remote
      ? fetchTargetEdition(controller.signal)
      : Promise.resolve(expectedEdition)
    const targetMe = remote
      ? fetchMe(authFetch, controller.signal)
      : Promise.resolve<MeResponse | null>(null)

    Promise.all([originMe, targetEdition, targetMe])
      .then(([originResponse, edition, targetResponse]) => {
        if (controller.signal.aborted) return

        // The browser session belongs to the origin hub. Its user and
        // capabilities remain authoritative while a remote device is active.
        const origin = validMeForEdition(originResponse, expectedEdition)
          ? originResponse
          : expectedEdition === "personal" ? PERSONAL_ME : null
        if (!origin || edition === null) {
          setMeState({ ...applyMe(UNRESOLVED_ME), checked: false })
          return
        }

        if (!remote) {
          setMeState({ ...applyMe(origin), checked: true })
          return
        }

        // A personal target has no narrower role model. Team targets must
        // return a valid service-account identity, but that identity never
        // replaces the origin user or its storage/cache scope.
        const target = validMeForEdition(targetResponse, edition)
          ? targetResponse
          : edition === "personal" ? PERSONAL_ME : null
        if (!target) {
          setMeState({ ...applyMe(UNRESOLVED_ME), checked: false })
          return
        }

        setMeState({
          ...applyMe({
            authenticated: origin.authenticated,
            edition: origin.edition,
            user: origin.user,
            capabilities: intersectCapabilities(origin.capabilities, target.capabilities),
          }),
          checked: true,
        })
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setMeState({ ...applyMe(UNRESOLVED_ME), checked: false })
      })
    return () => {
      controller.abort()
      if (activeController.current === controller) activeController.current = null
    }
  }, [expectedEdition, fetchKey])

  useEffect(() => {
    const handleAuthChange = () => {
      activeController.current?.abort()
      preserveIdentityOnNextFetch.current = false
      setMe(UNRESOLVED_ME)
      setActiveIdentity(null)
      setMeState({ ...UNRESOLVED_ME, checked: false })
      setFetchKey((k) => k + 1)
    }
    const handleDevicesChange = (event: Event) => {
      const activeDeviceId = getActiveDeviceId()
      if (activeDeviceId === LOCAL_DEVICE_ID) return
      const changedDeviceId = (event as CustomEvent<{ deviceId?: string }>).detail?.deviceId
      if (changedDeviceId && changedDeviceId !== activeDeviceId) return

      // A credential/account update may change the remote /api/me response.
      // Drop all affordances immediately, retain the origin user/cache scope,
      // and abort any stale identity request before starting the replacement.
      activeController.current?.abort()
      preserveIdentityOnNextFetch.current = true
      setMe(UNRESOLVED_ME)
      setMeState((current) => ({
        ...current,
        capabilities: NO_CAPABILITIES,
        checked: false,
      }))
      setFetchKey((k) => k + 1)
    }
    window.addEventListener("cogpit-auth-changed", handleAuthChange)
    window.addEventListener("cogpit-devices-changed", handleDevicesChange)
    return () => {
      window.removeEventListener("cogpit-auth-changed", handleAuthChange)
      window.removeEventListener("cogpit-devices-changed", handleDevicesChange)
    }
  }, [])

  return me
}
