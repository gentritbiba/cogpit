import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"

vi.mock("@/lib/auth", () => ({
  isRemoteClient: vi.fn(),
  getToken: vi.fn(),
  clearToken: vi.fn(),
}))

import { isRemoteClient, getToken, clearToken } from "@/lib/auth"
import { useNetworkAuth } from "../useNetworkAuth"

const mockedIsRemoteClient = vi.mocked(isRemoteClient)
const mockedGetToken = vi.mocked(getToken)
const mockedClearToken = vi.mocked(clearToken)

describe("useNetworkAuth", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it("returns authenticated=true for local clients", () => {
    mockedIsRemoteClient.mockReturnValue(false)
    mockedGetToken.mockReturnValue(null)

    const { result } = renderHook(() => useNetworkAuth())

    expect(result.current.isRemote).toBe(false)
    expect(result.current.authenticated).toBe(true)
  })

  it("returns authenticated=true for remote client with token", () => {
    mockedIsRemoteClient.mockReturnValue(true)
    mockedGetToken.mockReturnValue("some-token")

    const { result } = renderHook(() => useNetworkAuth())

    expect(result.current.isRemote).toBe(true)
    expect(result.current.authenticated).toBe(true)
  })

  it("returns authenticated=false for remote client without token", () => {
    mockedIsRemoteClient.mockReturnValue(true)
    mockedGetToken.mockReturnValue(null)

    const { result } = renderHook(() => useNetworkAuth())

    expect(result.current.isRemote).toBe(true)
    expect(result.current.authenticated).toBe(false)
  })

  it("sets authenticated=true when handleAuthenticated is called", () => {
    mockedIsRemoteClient.mockReturnValue(true)
    mockedGetToken.mockReturnValue(null)

    const { result } = renderHook(() => useNetworkAuth())
    expect(result.current.authenticated).toBe(false)

    act(() => {
      result.current.handleAuthenticated()
    })
    expect(result.current.authenticated).toBe(true)
  })

  it("clears token and sets authenticated=false on logout", () => {
    mockedIsRemoteClient.mockReturnValue(true)
    mockedGetToken.mockReturnValue("some-token")

    const { result } = renderHook(() => useNetworkAuth())
    expect(result.current.authenticated).toBe(true)

    act(() => {
      result.current.logout()
    })
    expect(result.current.authenticated).toBe(false)
    expect(mockedClearToken).toHaveBeenCalled()
  })

  it("responds to cogpit-auth-required event for remote clients", () => {
    mockedIsRemoteClient.mockReturnValue(true)
    mockedGetToken.mockReturnValue("some-token")

    const { result } = renderHook(() => useNetworkAuth())
    expect(result.current.authenticated).toBe(true)

    act(() => {
      window.dispatchEvent(new Event("cogpit-auth-required"))
    })
    expect(result.current.authenticated).toBe(false)
  })

  it("does not respond to cogpit-auth-required for local clients", () => {
    mockedIsRemoteClient.mockReturnValue(false)
    mockedGetToken.mockReturnValue(null)

    const { result } = renderHook(() => useNetworkAuth())
    expect(result.current.authenticated).toBe(true)

    act(() => {
      window.dispatchEvent(new Event("cogpit-auth-required"))
    })
    // Still authenticated for local
    expect(result.current.authenticated).toBe(true)
  })

  it("cleans up event listener on unmount", () => {
    mockedIsRemoteClient.mockReturnValue(true)
    mockedGetToken.mockReturnValue("token")

    const addSpy = vi.spyOn(window, "addEventListener")
    const removeSpy = vi.spyOn(window, "removeEventListener")

    const { unmount } = renderHook(() => useNetworkAuth())

    expect(addSpy).toHaveBeenCalledWith("cogpit-auth-required", expect.any(Function))

    unmount()

    expect(removeSpy).toHaveBeenCalledWith("cogpit-auth-required", expect.any(Function))

    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  it("handleAuthenticated then logout cycle", () => {
    mockedIsRemoteClient.mockReturnValue(true)
    mockedGetToken.mockReturnValue(null)

    const { result } = renderHook(() => useNetworkAuth())
    expect(result.current.authenticated).toBe(false)

    act(() => result.current.handleAuthenticated())
    expect(result.current.authenticated).toBe(true)

    act(() => result.current.logout())
    expect(result.current.authenticated).toBe(false)
    expect(mockedClearToken).toHaveBeenCalledTimes(1)
  })

  it("auth-required event after re-authentication", () => {
    mockedIsRemoteClient.mockReturnValue(true)
    mockedGetToken.mockReturnValue(null)

    const { result } = renderHook(() => useNetworkAuth())

    // Authenticate
    act(() => result.current.handleAuthenticated())
    expect(result.current.authenticated).toBe(true)

    // Server requires re-auth
    act(() => {
      window.dispatchEvent(new Event("cogpit-auth-required"))
    })
    expect(result.current.authenticated).toBe(false)
  })
})
