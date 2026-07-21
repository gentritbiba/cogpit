import { useState, useEffect, useCallback, useRef } from "react"
import { checkAuthSession, isRemoteClient, logoutSession } from "@/lib/auth"
import type { NetworkAuth } from "@/contexts/AppContext"

export function useNetworkAuth(): NetworkAuth {
  const remote = isRemoteClient()
  const [authenticated, setAuthenticated] = useState(!remote)
  const [authChecked, setAuthChecked] = useState(!remote)
  const authVersionRef = useRef(0)

  useEffect(() => {
    if (!remote) return

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
  }, [remote])

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
