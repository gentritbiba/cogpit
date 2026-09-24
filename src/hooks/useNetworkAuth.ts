import { useState, useEffect, useCallback, useRef } from "react"
import {
  checkAuthSession,
  getServerHello,
  isRemoteClient,
  logoutSession,
  refreshServerHello,
  type ServerHello,
} from "@/lib/auth"
import { clearSessionListCache } from "@/lib/sessionListCache"
import type { CogpitEdition } from "../../shared/contracts/identity"

export interface NetworkAuth {
  isRemote: boolean
  /** Edition reported by the public handshake; null until it resolves. */
  edition: CogpitEdition | null
  authChecked: boolean
  authenticated: boolean
  /** Account sign-in with no accounts yet: the gate shows the server's first-time setup. */
  setupRequired: boolean
  handleAuthenticated: () => void
  /** Re-read the public handshake after the setup state changes. */
  refreshServerState: () => Promise<void>
  logout: () => void
}

export function useNetworkAuth(): NetworkAuth {
  const remote = isRemoteClient()
  // null until the public handshake resolves. It decides two things: whether
  // requests must carry a session (always for remote clients, and for local
  // browsers on a server with account sign-in) and whether the first account
  // still has to be created before anyone can sign in at all.
  const [hello, setHello] = useState<ServerHello | null>(null)
  const [authenticated, setAuthenticated] = useState(false)
  const [sessionChecked, setSessionChecked] = useState(false)
  const authVersionRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    void getServerHello().then((resolved) => {
      if (!cancelled) setHello(resolved)
    })
    return () => { cancelled = true }
  }, [])

  // Remote clients are gated regardless of sign-in, so their session check
  // starts immediately instead of waiting on the handshake.
  const gated = remote ? true : hello === null ? null : hello.signIn === "account"

  useEffect(() => {
    if (gated === null) return
    if (!gated) {
      setAuthenticated(true)
      setSessionChecked(true)
      return
    }

    let cancelled = false
    const version = authVersionRef.current
    void checkAuthSession().then((valid) => {
      if (!cancelled && authVersionRef.current === version) {
        setAuthenticated(valid)
        setSessionChecked(true)
      }
    })

    return () => {
      cancelled = true
    }
  }, [gated])

  // Listen even while a local client is provisionally treated as personal.
  // A failed startup hello intentionally falls back to personal, but a later
  // API 401 can successfully re-probe the same server as one with account
  // sign-in and emit this event. Re-probing here upgrades the gate instead of
  // leaving the app in an authenticated-looking state. A server that signs in
  // with the network password stays open to local browsers.
  useEffect(() => {
    let cancelled = false
    const handler = () => {
      const version = ++authVersionRef.current
      const requireAuthentication = () => {
        if (cancelled || authVersionRef.current !== version) return
        setAuthenticated(false)
        setSessionChecked(true)
      }

      if (remote || hello?.signIn === "account") {
        requireAuthentication()
        return
      }

      void refreshServerHello().then((resolved) => {
        if (cancelled || authVersionRef.current !== version) return
        setHello(resolved)
        if (resolved.signIn === "account") requireAuthentication()
      })
    }

    window.addEventListener("cogpit-auth-required", handler)
    return () => {
      cancelled = true
      window.removeEventListener("cogpit-auth-required", handler)
    }
  }, [hello?.signIn, remote])

  const handleAuthenticated = useCallback(() => {
    authVersionRef.current += 1
    setAuthenticated(true)
    setSessionChecked(true)
    window.dispatchEvent(new Event("cogpit-auth-changed"))
  }, [])

  const refreshServerState = useCallback(async () => {
    setHello(await refreshServerHello())
  }, [])

  const logout = useCallback(() => {
    // Clear while the signed-in identity still scopes the cache key.
    clearSessionListCache()
    authVersionRef.current += 1
    setAuthenticated(false)
    setSessionChecked(true)
    void logoutSession().finally(() => {
      window.dispatchEvent(new Event("cogpit-auth-changed"))
    })
  }, [])

  return {
    isRemote: remote,
    edition: hello?.edition ?? null,
    authChecked: sessionChecked && hello !== null,
    authenticated,
    setupRequired: hello?.setupRequired === true,
    handleAuthenticated,
    refreshServerState,
    logout,
  }
}
