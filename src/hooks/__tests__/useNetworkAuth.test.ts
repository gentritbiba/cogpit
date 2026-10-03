import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

vi.mock("@/lib/auth", () => ({
  isRemoteClient: vi.fn(),
  checkAuthSession: vi.fn(),
  logoutSession: vi.fn(),
  getServerHello: vi.fn(),
  refreshServerHello: vi.fn(),
}))

import {
  isRemoteClient,
  checkAuthSession,
  logoutSession,
  getServerHello,
  refreshServerHello,
} from "@/lib/auth"
import { useNetworkAuth } from "../useNetworkAuth"
import { __resetIdentityForTest, setActiveIdentity } from "@/lib/device"
import { readCachedList, sessionListCacheKeys, writeCachedList } from "@/lib/sessionListCache"

const mockedIsRemoteClient = vi.mocked(isRemoteClient)
const mockedCheckAuthSession = vi.mocked(checkAuthSession)
const mockedLogoutSession = vi.mocked(logoutSession)
const mockedGetServerHello = vi.mocked(getServerHello)
const mockedRefreshServerHello = vi.mocked(refreshServerHello)

const PERSONAL_HELLO = { edition: "personal", signIn: "password", setupRequired: false } as const
const ACCOUNT_HELLO = { edition: "team", signIn: "account", setupRequired: false } as const
const ACCOUNT_SETUP_HELLO = { edition: "team", signIn: "account", setupRequired: true } as const

describe("useNetworkAuth", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    __resetIdentityForTest()
    mockedCheckAuthSession.mockResolvedValue(false)
    mockedLogoutSession.mockResolvedValue()
    mockedGetServerHello.mockResolvedValue(PERSONAL_HELLO)
    mockedRefreshServerHello.mockResolvedValue(PERSONAL_HELLO)
  })

  it("trusts a direct local client on a personal server without checking a cookie", async () => {
    mockedIsRemoteClient.mockReturnValue(false)
    const { result } = renderHook(() => useNetworkAuth())

    await waitFor(() => expect(result.current.authenticated).toBe(true))
    expect(result.current).toMatchObject({ isRemote: false, edition: "personal", authChecked: true })
    expect(mockedCheckAuthSession).not.toHaveBeenCalled()
  })

  it("gates a local client when the server signs in with accounts", async () => {
    mockedIsRemoteClient.mockReturnValue(false)
    mockedGetServerHello.mockResolvedValue(ACCOUNT_HELLO)
    const { result } = renderHook(() => useNetworkAuth())

    expect(result.current.authChecked).toBe(false)
    await waitFor(() => expect(result.current.authChecked).toBe(true))
    expect(result.current.edition).toBe("team")
    expect(result.current.authenticated).toBe(false)
    expect(mockedCheckAuthSession).toHaveBeenCalledOnce()
  })

  it("keeps trusting a local client when a server of another edition signs in with the password", async () => {
    mockedIsRemoteClient.mockReturnValue(false)
    mockedGetServerHello.mockResolvedValue({ ...ACCOUNT_HELLO, signIn: "password" })
    const { result } = renderHook(() => useNetworkAuth())

    await waitFor(() => expect(result.current.authenticated).toBe(true))
    expect(result.current.edition).toBe("team")
    expect(mockedCheckAuthSession).not.toHaveBeenCalled()
  })

  it("restores a local account session from the HttpOnly cookie", async () => {
    mockedIsRemoteClient.mockReturnValue(false)
    mockedGetServerHello.mockResolvedValue(ACCOUNT_HELLO)
    mockedCheckAuthSession.mockResolvedValue(true)
    const { result } = renderHook(() => useNetworkAuth())

    await waitFor(() => expect(result.current.authenticated).toBe(true))
  })

  it("responds to auth-required on a local client of an account server", async () => {
    mockedIsRemoteClient.mockReturnValue(false)
    mockedGetServerHello.mockResolvedValue(ACCOUNT_HELLO)
    mockedCheckAuthSession.mockResolvedValue(true)
    const { result } = renderHook(() => useNetworkAuth())
    await waitFor(() => expect(result.current.authenticated).toBe(true))

    act(() => window.dispatchEvent(new Event("cogpit-auth-required")))
    expect(result.current.authenticated).toBe(false)
  })

  it("reports an open first-time setup so the gate can render it", async () => {
    mockedIsRemoteClient.mockReturnValue(true)
    mockedGetServerHello.mockResolvedValue(ACCOUNT_SETUP_HELLO)
    const { result } = renderHook(() => useNetworkAuth())

    await waitFor(() => expect(result.current.setupRequired).toBe(true))
    expect(result.current.authenticated).toBe(false)
  })

  it("never reports a setup on a personal server", async () => {
    mockedIsRemoteClient.mockReturnValue(false)
    const { result } = renderHook(() => useNetworkAuth())

    await waitFor(() => expect(result.current.authChecked).toBe(true))
    expect(result.current.setupRequired).toBe(false)
  })

  it("re-reads the probe when the setup closes", async () => {
    mockedIsRemoteClient.mockReturnValue(true)
    mockedGetServerHello.mockResolvedValue(ACCOUNT_SETUP_HELLO)
    mockedRefreshServerHello.mockResolvedValue(ACCOUNT_HELLO)
    const { result } = renderHook(() => useNetworkAuth())
    await waitFor(() => expect(result.current.setupRequired).toBe(true))

    await act(() => result.current.refreshServerState())

    expect(result.current.setupRequired).toBe(false)
  })

  it("restores a valid remote HttpOnly-cookie session", async () => {
    mockedIsRemoteClient.mockReturnValue(true)
    mockedCheckAuthSession.mockResolvedValue(true)
    const { result } = renderHook(() => useNetworkAuth())

    expect(result.current.authenticated).toBe(false)
    await waitFor(() => expect(result.current.authenticated).toBe(true))
    expect(mockedCheckAuthSession).toHaveBeenCalledOnce()
  })

  it("distinguishes a pending remote session check from a rejected session", async () => {
    mockedIsRemoteClient.mockReturnValue(true)
    let resolveCheck!: (valid: boolean) => void
    mockedCheckAuthSession.mockReturnValue(new Promise((resolve) => { resolveCheck = resolve }))
    const { result } = renderHook(() => useNetworkAuth())

    expect(result.current).toMatchObject({ authenticated: false, authChecked: false })
    resolveCheck(false)
    await waitFor(() => expect(result.current.authChecked).toBe(true))
    expect(result.current.authenticated).toBe(false)
  })

  it("keeps an expired remote session unauthenticated", async () => {
    mockedIsRemoteClient.mockReturnValue(true)
    const { result } = renderHook(() => useNetworkAuth())
    await waitFor(() => expect(mockedCheckAuthSession).toHaveBeenCalledOnce())
    expect(result.current.authenticated).toBe(false)
  })

  it("marks the session authenticated and announces the change after login", () => {
    mockedIsRemoteClient.mockReturnValue(true)
    const changed = vi.fn()
    window.addEventListener("cogpit-auth-changed", changed)
    const { result } = renderHook(() => useNetworkAuth())

    act(() => result.current.handleAuthenticated())
    expect(result.current.authenticated).toBe(true)
    expect(changed).toHaveBeenCalledOnce()
    window.removeEventListener("cogpit-auth-changed", changed)
  })

  it("does not let a stale startup check undo a completed login", async () => {
    mockedIsRemoteClient.mockReturnValue(true)
    let resolveCheck!: (valid: boolean) => void
    mockedCheckAuthSession.mockReturnValue(new Promise((resolve) => { resolveCheck = resolve }))
    const { result } = renderHook(() => useNetworkAuth())

    act(() => result.current.handleAuthenticated())
    resolveCheck(false)
    await Promise.resolve()
    expect(result.current.authenticated).toBe(true)
  })

  it("revokes the server session and hides authenticated UI on logout", async () => {
    mockedIsRemoteClient.mockReturnValue(true)
    mockedCheckAuthSession.mockResolvedValue(true)
    const { result } = renderHook(() => useNetworkAuth())
    await waitFor(() => expect(result.current.authenticated).toBe(true))

    act(() => result.current.logout())
    expect(result.current.authenticated).toBe(false)
    await waitFor(() => expect(mockedLogoutSession).toHaveBeenCalledOnce())
  })

  it("clears the signed-in identity's session list cache on logout", async () => {
    mockedIsRemoteClient.mockReturnValue(true)
    mockedCheckAuthSession.mockResolvedValue(true)
    setActiveIdentity("u_1")
    writeCachedList(sessionListCacheKeys.activeSessions, [{ sessionId: "s1" }])
    const { result } = renderHook(() => useNetworkAuth())
    await waitFor(() => expect(result.current.authenticated).toBe(true))

    act(() => result.current.logout())

    expect(readCachedList(sessionListCacheKeys.activeSessions)).toBeUndefined()
    expect(localStorage.getItem("cogpit:session-list-cache::local::u_1")).toBeNull()
  })

  it("responds to auth-required only for remote clients", async () => {
    mockedIsRemoteClient.mockReturnValue(true)
    mockedCheckAuthSession.mockResolvedValue(true)
    const { result } = renderHook(() => useNetworkAuth())
    await waitFor(() => expect(result.current.authenticated).toBe(true))

    act(() => window.dispatchEvent(new Event("cogpit-auth-required")))
    expect(result.current.authenticated).toBe(false)
  })

  it("does not respond to auth-required for local personal clients", async () => {
    mockedIsRemoteClient.mockReturnValue(false)
    const { result } = renderHook(() => useNetworkAuth())
    await waitFor(() => expect(result.current.authenticated).toBe(true))

    act(() => window.dispatchEvent(new Event("cogpit-auth-required")))
    await waitFor(() => expect(mockedRefreshServerHello).toHaveBeenCalledOnce())
    expect(result.current.authenticated).toBe(true)
  })

  it("upgrades a transient local hello fallback when a later request requires auth", async () => {
    mockedIsRemoteClient.mockReturnValue(false)
    mockedGetServerHello.mockResolvedValue(PERSONAL_HELLO)
    mockedRefreshServerHello.mockResolvedValue(ACCOUNT_HELLO)
    const { result } = renderHook(() => useNetworkAuth())
    await waitFor(() => expect(result.current.authenticated).toBe(true))

    act(() => window.dispatchEvent(new Event("cogpit-auth-required")))

    await waitFor(() => expect(result.current.authenticated).toBe(false))
    expect(mockedRefreshServerHello).toHaveBeenCalledOnce()
  })

  it("cleans up its auth-required listener", () => {
    mockedIsRemoteClient.mockReturnValue(true)
    const addSpy = vi.spyOn(window, "addEventListener")
    const removeSpy = vi.spyOn(window, "removeEventListener")
    const { unmount } = renderHook(() => useNetworkAuth())

    expect(addSpy).toHaveBeenCalledWith("cogpit-auth-required", expect.any(Function))
    unmount()
    expect(removeSpy).toHaveBeenCalledWith("cogpit-auth-required", expect.any(Function))
  })

  it("ignores a session check that resolves after unmount", async () => {
    mockedIsRemoteClient.mockReturnValue(true)
    let resolveCheck!: (valid: boolean) => void
    mockedCheckAuthSession.mockReturnValue(new Promise((resolve) => { resolveCheck = resolve }))
    const { unmount } = renderHook(() => useNetworkAuth())
    unmount()
    resolveCheck(true)
    await Promise.resolve()
  })
})
