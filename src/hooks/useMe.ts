import { useState, useEffect } from "react"
import { authFetch } from "@/lib/auth"
import { setMe } from "@/lib/capabilities"
import { setActiveIdentity } from "@/lib/device"
import { ALL_CAPABILITIES, type MeResponse } from "../../shared/contracts/team"

/**
 * Personal-parity fallback served while /api/me is loading and on any
 * failure. The server enforces capabilities regardless, so optimistic
 * all-capabilities defaults can never grant real access — they only avoid
 * flashing hidden UI in the personal edition.
 */
const PERSONAL_ME: MeResponse = {
  authenticated: true,
  edition: "personal",
  user: null,
  capabilities: ALL_CAPABILITIES,
}

/** Mirror an identity into the render-time gate + storage scoping cells. */
function applyMe(me: MeResponse): MeResponse {
  setMe(me)
  setActiveIdentity(me.user?.id ?? null)
  return me
}

/**
 * The signed-in identity from `/api/me`, refreshed whenever auth state
 * changes (login/logout). Personal edition always resolves the all-capability
 * null-user shape.
 */
export function useMe(): MeResponse {
  const [me, setMeState] = useState<MeResponse>(PERSONAL_ME)
  // Bump to re-fetch the identity (e.g. after login on a gated client)
  const [fetchKey, setFetchKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    authFetch("/api/me", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Identity request failed (${res.status})`)
        return await res.json() as MeResponse
      })
      .then((data) => {
        if (!controller.signal.aborted) setMeState(applyMe(data))
      })
      .catch(() => {
        if (!controller.signal.aborted) setMeState(applyMe(PERSONAL_ME))
      })
    return () => controller.abort()
  }, [fetchKey])

  useEffect(() => {
    const handler = () => setFetchKey((k) => k + 1)
    window.addEventListener("cogpit-auth-changed", handler)
    return () => window.removeEventListener("cogpit-auth-changed", handler)
  }, [])

  return me
}
