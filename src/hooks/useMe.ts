import { useCallback, useState, useEffect, useRef } from "react"
import { authFetch, hubFetch } from "@/lib/auth"
import { setMe } from "@/lib/capabilities"
import { getActiveDeviceId, isRemoteDeviceActive, LOCAL_DEVICE_ID, setActiveIdentity, switchDevice } from "@/lib/device"
import { onGate } from "@/lib/gateEvents"
import {
  ALL_CAPABILITIES,
  isCogpitEdition,
  NO_CAPABILITIES,
  type AccountPublic,
  type Capabilities,
  type CapabilitySet,
  type CogpitEdition,
  type MeResponse,
} from "../../shared/contracts/identity"

/**
 * Personal-parity fallback used when a known-personal server has no usable
 * /api/me response. Origins and targets of any other edition fail closed.
 */
const PERSONAL_ME: MeResponse = {
  authenticated: true,
  edition: "personal",
  user: null,
  capabilities: ALL_CAPABILITIES,
}

const UNRESOLVED_ME: MeState = {
  authenticated: false,
  edition: null,
  user: null,
  capabilities: NO_CAPABILITIES,
  checked: false,
}

const CAPABILITY_KEYS = Object.keys(ALL_CAPABILITIES) as (keyof Capabilities)[]

function validMeForEdition(me: MeResponse | null, edition: CogpitEdition): me is MeResponse {
  return me !== null
    && me.edition === edition
    && me.authenticated
    && (edition === "personal" ? me.user === null : me.user !== null)
    && CAPABILITY_KEYS.every((capability) => typeof me.capabilities?.[capability] === "boolean")
}

/**
 * What the caller may do on a remote device through the hub: what the device
 * grants, less what the hub withholds. A capability an edition adds is held
 * when the device grants it and the hub, which may not know it, does not deny it.
 */
function intersectCapabilities(outer: CapabilitySet, target: CapabilitySet): CapabilitySet {
  const held: Record<string, boolean> = {}
  for (const [capability, granted] of Object.entries(target)) {
    held[capability] = granted === true && outer[capability] !== false
  }
  return { ...NO_CAPABILITIES, ...held }
}

/** A server from before the `browser` capability kept its Browser panel to whoever had `hostFiles`. */
function withBrowserCapability(me: MeResponse | null): MeResponse | null {
  const capabilities = me?.capabilities
  if (!me || !capabilities || typeof capabilities.browser === "boolean") return me
  return { ...me, capabilities: { ...capabilities, browser: capabilities.hostFiles === true } }
}

async function fetchMe(
  fetcher: typeof authFetch,
  signal: AbortSignal,
): Promise<MeResponse | null> {
  try {
    const res = await fetcher("/api/me", { signal })
    if (!res.ok) return null
    return withBrowserCapability(await res.json() as MeResponse)
  } catch {
    return null
  }
}

async function fetchTargetEdition(signal: AbortSignal): Promise<CogpitEdition | null> {
  try {
    const res = await authFetch("/api/hello", { signal })
    if (!res.ok) return null
    const data = await res.json() as { edition?: unknown }
    return isCogpitEdition(data.edition) ? data.edition : "personal"
  } catch {
    return null
  }
}

export interface MeState extends Omit<MeResponse, "edition"> {
  /** Null until the active device's identity is known. */
  edition: CogpitEdition | null
  /** True after the current auth identity's /api/me request has settled. */
  checked: boolean
}

/**
 * Publish the active device's identity to the render-time gates, or null while
 * it is unresolved. Storage stays scoped to the hub's signed-in user, who owns
 * this browser session.
 */
function applyMe(me: MeResponse | null, hubUser: AccountPublic | null): MeState {
  setMe(me, hubUser)
  setActiveIdentity(hubUser?.id ?? null)
  return me ? { ...me, checked: true } : UNRESOLVED_ME
}

/**
 * The caller's identity on the active device, from `/api/me`, refreshed
 * whenever auth state changes (login/logout) and when the server starts
 * refusing the caller's requests behind its gate. On a remote device it is the
 * device's edition and the account the hub holds there, with no more
 * capabilities than the hub user has.
 */
export function useMe(expectedEdition: CogpitEdition | null): MeState {
  const [me, setMeState] = useState<MeState>(UNRESOLVED_ME)
  // Bump to re-fetch the identity (e.g. after login on a gated client)
  const [fetchKey, setFetchKey] = useState(0)
  const activeController = useRef<AbortController | null>(null)
  const preserveIdentityOnNextFetch = useRef(false)

  useEffect(() => {
    activeController.current?.abort()
    if (expectedEdition === null) {
      preserveIdentityOnNextFetch.current = false
      setMe(null)
      setMeState(UNRESOLVED_ME)
      return
    }
    const preserveIdentity = preserveIdentityOnNextFetch.current
    preserveIdentityOnNextFetch.current = false
    setMe(null)
    setMeState((current) => preserveIdentity
      ? { ...current, capabilities: NO_CAPABILITIES, checked: false }
      : UNRESOLVED_ME)
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
        // A hub that keeps its caller out proxies nothing for them: back to
        // this machine, where they can see why and what lets them back in.
        if (remote && origin?.gate) {
          switchDevice(LOCAL_DEVICE_ID)
          return
        }
        if (!origin || edition === null) {
          setMeState(applyMe(null, null))
          return
        }

        if (!remote) {
          setMeState(applyMe(origin, origin.user))
          return
        }

        // A target with accounts must name the one the hub signs in as there.
        const target = validMeForEdition(targetResponse, edition)
          ? targetResponse
          : edition === "personal" ? PERSONAL_ME : null
        if (!target) {
          setMeState(applyMe(null, null))
          return
        }

        setMeState(applyMe({
          authenticated: target.authenticated,
          edition: target.edition,
          user: target.user,
          capabilities: intersectCapabilities(origin.capabilities, target.capabilities),
          ...(target.enforcesSessionAccess && { enforcesSessionAccess: true }),
          ...(target.gate && { gate: target.gate }),
        }, origin.user))
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setMeState(applyMe(null, null))
      })
    return () => {
      controller.abort()
      if (activeController.current === controller) activeController.current = null
    }
  }, [expectedEdition, fetchKey])

  // Drop all affordances immediately, retain the hub's storage scope, and
  // abort any stale identity request before starting the replacement.
  const refetchKeepingIdentity = useCallback(() => {
    activeController.current?.abort()
    preserveIdentityOnNextFetch.current = true
    setMe(null)
    setMeState((current) => ({
      ...current,
      capabilities: NO_CAPABILITIES,
      checked: false,
    }))
    setFetchKey((k) => k + 1)
  }, [])

  useEffect(() => {
    const handleAuthChange = () => {
      activeController.current?.abort()
      preserveIdentityOnNextFetch.current = false
      setMeState(applyMe(null, null))
      setFetchKey((k) => k + 1)
    }
    const handleDevicesChange = (event: Event) => {
      const activeDeviceId = getActiveDeviceId()
      if (activeDeviceId === LOCAL_DEVICE_ID) return
      const changedDeviceId = (event as CustomEvent<{ deviceId?: string }>).detail?.deviceId
      if (changedDeviceId && changedDeviceId !== activeDeviceId) return

      // A credential/account update may change the remote /api/me response.
      refetchKeepingIdentity()
    }
    window.addEventListener("cogpit-auth-changed", handleAuthChange)
    window.addEventListener("cogpit-devices-changed", handleDevicesChange)
    return () => {
      window.removeEventListener("cogpit-auth-changed", handleAuthChange)
      window.removeEventListener("cogpit-devices-changed", handleDevicesChange)
    }
  }, [refetchKeepingIdentity])

  // A refusal behind the gate means the server now keeps the caller out,
  // which /api/me names. While the identity is being read, or already names
  // the gate, the refusals that keep arriving have nothing new to say.
  const watchesGate = me.checked && !me.gate
  useEffect(() => {
    if (!watchesGate) return
    return onGate(refetchKeepingIdentity)
  }, [watchesGate, refetchKeepingIdentity])

  return me
}
