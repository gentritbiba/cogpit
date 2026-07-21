import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

vi.mock("@/lib/auth", () => ({
  isRemoteClient: vi.fn(),
  checkAuthSession: vi.fn(),
  logoutSession: vi.fn(),
}))

import { isRemoteClient, checkAuthSession, logoutSession } from "@/lib/auth"
import { useNetworkAuth } from "../useNetworkAuth"

const mockedIsRemoteClient = vi.mocked(isRemoteClient)
const mockedCheckAuthSession = vi.mocked(checkAuthSession)
const mockedLogoutSession = vi.mocked(logoutSession)

describe("useNetworkAuth", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedCheckAuthSession.mockResolvedValue(false)
    mockedLogoutSession.mockResolvedValue()
  })

  it("trusts a direct local client without checking a cookie", () => {
    mockedIsRemoteClient.mockReturnValue(false)
    const { result } = renderHook(() => useNetworkAuth())
    expect(result.current).toMatchObject({ isRemote: false, authenticated: true })
    expect(mockedCheckAuthSession).not.toHaveBeenCalled()
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

  it("responds to auth-required only for remote clients", async () => {
    mockedIsRemoteClient.mockReturnValue(true)
    mockedCheckAuthSession.mockResolvedValue(true)
    const { result } = renderHook(() => useNetworkAuth())
    await waitFor(() => expect(result.current.authenticated).toBe(true))

    act(() => window.dispatchEvent(new Event("cogpit-auth-required")))
    expect(result.current.authenticated).toBe(false)
  })

  it("does not respond to auth-required for local clients", () => {
    mockedIsRemoteClient.mockReturnValue(false)
    const { result } = renderHook(() => useNetworkAuth())
    act(() => window.dispatchEvent(new Event("cogpit-auth-required")))
    expect(result.current.authenticated).toBe(true)
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
