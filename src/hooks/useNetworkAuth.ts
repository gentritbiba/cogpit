import { useState, useEffect, useCallback, useRef } from "react"
import {
  checkAuthSession,
  getServerHello,
  isRemoteClient,
  logoutSession,
  refreshServerHello,
  type ServerHello,
} from "@/lib/auth"
import type { NetworkAuth } from "@/contexts/AppContext"

export function useNetworkAuth(): NetworkAuth {
  const remote = isRemoteClient()
  // null until the public handshake resolves. It decides two things: whether
  // requests must carry a session (always for remote clients, and for local
  // browsers on a team server) and whether the founding admin still has to be
  // created before anyone can log in at all.
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

  // Remote clients are gated regardless of edition, so their session check
  // starts immediately instead of waiting on the handshake.
  const gated = remote ? true : hello === null ? null : hello.edition === "team"

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

    const handler = () => {
      authVersionRef.current += 1
      setAuthenticated(false)
      setSessionChecked(true)
    }
    window.addEventListener("cogpit-auth-required", handler)
    return () => {
      cancelled = true
      window.removeEventListener("cogpit-auth-required", handler)
    }
  }, [gated])

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
    authVersionRef.current += 1
    setAuthenticated(false)
    setSessionChecked(true)
    void logoutSession().finally(() => {
      window.dispatchEvent(new Event("cogpit-auth-changed"))
    })
  }, [])

  return {
    isRemote: remote,
    authChecked: sessionChecked && hello !== null,
    authenticated,
    needsBootstrap: hello?.needsBootstrap === true,
    handleAuthenticated,
    refreshServerState,
    logout,
  }
}
