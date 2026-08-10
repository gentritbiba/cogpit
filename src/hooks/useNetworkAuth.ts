import { useState, useEffect, useCallback, useRef } from "react"
import { checkAuthSession, getServerEdition, isRemoteClient, logoutSession } from "@/lib/auth"
import type { NetworkAuth } from "@/contexts/AppContext"

export function useNetworkAuth(): NetworkAuth {
  const remote = isRemoteClient()
  // Whether requests must carry an authenticated session: always for remote
  // clients, and for local browsers when the server is team edition. null
  // while the edition handshake is still resolving for a local client.
  const [gated, setGated] = useState<boolean | null>(remote ? true : null)
  const [authenticated, setAuthenticated] = useState(false)
  const [authChecked, setAuthChecked] = useState(false)
  const authVersionRef = useRef(0)

  useEffect(() => {
    if (remote) return

    let cancelled = false
    void getServerEdition().then((edition) => {
      if (!cancelled) setGated(edition === "team")
    })
    return () => { cancelled = true }
  }, [remote])

  useEffect(() => {
    if (gated === null) return
    if (!gated) {
      setAuthenticated(true)
      setAuthChecked(true)
      return
    }

    let cancelled = false
    const version = authVersionRef.current
    void checkAuthSession().then((valid) => {
      if (!cancelled && authVersionRef.current === version) {
        setAuthenticated(valid)
        setAuthChecked(true)
      }
    })

    const handler = () => {
      authVersionRef.current += 1
      setAuthenticated(false)
      setAuthChecked(true)
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
    setAuthChecked(true)
    window.dispatchEvent(new Event("cogpit-auth-changed"))
  }, [])

  const logout = useCallback(() => {
    authVersionRef.current += 1
    setAuthenticated(false)
    setAuthChecked(true)
    void logoutSession().finally(() => {
      window.dispatchEvent(new Event("cogpit-auth-changed"))
    })
  }, [])

  return {
    isRemote: remote,
    authChecked,
    authenticated,
    handleAuthenticated,
    logout,
  }
}
