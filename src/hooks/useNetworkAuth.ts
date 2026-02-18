import { useState, useEffect, useCallback } from "react"
import { isRemoteClient, getToken, clearToken } from "@/lib/auth"

export function useNetworkAuth() {
  const remote = isRemoteClient()
  const [authenticated, setAuthenticated] = useState(!remote || !!getToken())

  useEffect(() => {
    if (!remote) return

    const handler = () => setAuthenticated(false)
    window.addEventListener("cogpit-auth-required", handler)
    return () => window.removeEventListener("cogpit-auth-required", handler)
  }, [remote])

  const handleAuthenticated = useCallback(() => {
    setAuthenticated(true)
  }, [])

  const logout = useCallback(() => {
    clearToken()
    setAuthenticated(false)
  }, [])

  return {
    isRemote: remote,
    authenticated,
    handleAuthenticated,
    logout,
  }
}
