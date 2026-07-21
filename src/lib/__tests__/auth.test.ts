import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  isRemoteClient,
  clearToken,
  checkAuthSession,
  logoutSession,
  authFetch,
  hubFetch,
  authUrl,
} from "@/lib/auth"

function setHostname(hostname: string) {
  Object.defineProperty(window, "location", {
    value: { hostname },
    writable: true,
    configurable: true,
  })
}

function setLocation(hostname: string, pathname: string) {
  Object.defineProperty(window, "location", {
    value: { hostname, pathname },
    writable: true,
    configurable: true,
  })
}

describe("auth", () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  afterEach(() => setHostname("localhost"))

  describe("isRemoteClient", () => {
    it.each(["localhost", "127.0.0.1", "::1"])("treats %s as local", (hostname) => {
      setHostname(hostname)
      expect(isRemoteClient()).toBe(false)
    })

    it.each(["example.com", "192.168.1.100"])("treats %s as remote", (hostname) => {
      setHostname(hostname)
      expect(isRemoteClient()).toBe(true)
    })

    it.each(["[::1]", "[0:0:0:0:0:0:0:1]"])(
      "treats bracketed IPv6 loopback %s as local",
      (hostname) => {
        setHostname(hostname)
        expect(isRemoteClient()).toBe(false)
      },
    )
  })

  describe("legacy token removal", () => {
    it("clears both legacy browser storage locations", () => {
      localStorage.setItem("cogpit-network-token", "local")
      sessionStorage.setItem("cogpit-network-token", "session")
      clearToken()
      expect(localStorage.getItem("cogpit-network-token")).toBeNull()
      expect(sessionStorage.getItem("cogpit-network-token")).toBeNull()
    })
  })

  describe("cookie session lifecycle", () => {
    it("treats local clients as authenticated without a request", async () => {
      setHostname("localhost")
      const fetchSpy = vi.spyOn(globalThis, "fetch")
      await expect(checkAuthSession()).resolves.toBe(true)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it("checks the protected session endpoint with same-origin credentials", async () => {
      setHostname("example.com")
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))

      await expect(checkAuthSession()).resolves.toBe(true)
      expect(fetchSpy).toHaveBeenCalledWith("/api/auth/session", expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      }))
      const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>
      expect(headers["X-Cogpit-Client"]).toBe("1")
    })

    it("returns false for an expired session or network failure", async () => {
      setHostname("example.com")
      const fetchSpy = vi.spyOn(globalThis, "fetch")
      fetchSpy.mockResolvedValueOnce(new Response("", { status: 401 }))
      await expect(checkAuthSession()).resolves.toBe(false)
      fetchSpy.mockRejectedValueOnce(new Error("offline"))
      await expect(checkAuthSession()).resolves.toBe(false)
    })

    it("logs out through the protected endpoint without exposing a token", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"))
      await logoutSession()
      expect(fetchSpy).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      }))
      const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>
      expect(headers["X-Cogpit-Client"]).toBe("1")
    })
  })

  describe("authFetch", () => {
    it("uses the HttpOnly cookie transport and client header", async () => {
      setHostname("example.com")
      const response = new Response("ok")
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response)

      await expect(authFetch("/api/test")).resolves.toBe(response)
      const [, init] = fetchSpy.mock.calls[0]
      const headers = init?.headers as Headers
      expect(init?.credentials).toBe("same-origin")
      expect(headers.get("Authorization")).toBeNull()
      expect(headers.get("X-Cogpit-Client")).toBe("1")
    })

    it("applies the active device prefix only to device-scoped API calls", async () => {
      setLocation("example.com", "/d/dev_x/")
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))

      await authFetch("/api/data")
      await authFetch("/api/hub/devices")
      expect(fetchSpy.mock.calls[0][0]).toBe("/hub/dev_x/api/data")
      expect(fetchSpy.mock.calls[1][0]).toBe("/api/hub/devices")
    })

    it("does not prefix local-device API calls", async () => {
      setLocation("localhost", "/-Users-foo/sess")
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
      await authFetch("/api/data")
      expect(fetchSpy.mock.calls[0][0]).toBe("/api/data")
    })

    it("fires auth-required on a remote 401", async () => {
      setHostname("example.com")
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }))
      const handler = vi.fn()
      window.addEventListener("cogpit-auth-required", handler)

      await expect(authFetch("/api/secure")).rejects.toThrow("Authentication required")
      expect(handler).toHaveBeenCalledOnce()
      window.removeEventListener("cogpit-auth-required", handler)
    })

    it("passes a local 401 through without changing auth state", async () => {
      setHostname("localhost")
      const response = new Response("", { status: 401 })
      vi.spyOn(globalThis, "fetch").mockResolvedValue(response)
      await expect(authFetch("/api/secure")).resolves.toBe(response)
    })

    it("preserves request options and headers", async () => {
      setHostname("example.com")
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))

      await authFetch("/api/data", {
        method: "POST",
        body: "hello",
        headers: {
          Authorization: "Bearer legacy-browser-token",
          "Content-Type": "application/json",
          "X-Custom": "value",
        },
      })
      const [, init] = fetchSpy.mock.calls[0]
      const headers = init?.headers as Headers
      expect(init?.method).toBe("POST")
      expect(init?.body).toBe("hello")
      expect(headers.get("Content-Type")).toBe("application/json")
      expect(headers.get("X-Custom")).toBe("value")
      expect(headers.get("Authorization")).toBeNull()
    })

    it("dispatches device-unreachable for attributed 502 responses", async () => {
      setLocation("localhost", "/d/dev_x/")
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad gateway", {
        status: 502,
        headers: { "X-Cogpit-Device": "dev_x" },
      }))
      const handler = vi.fn()
      window.addEventListener("cogpit-device-unreachable", handler as EventListener)

      await authFetch("/api/data")
      expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual({ deviceId: "dev_x" })
      window.removeEventListener("cogpit-device-unreachable", handler as EventListener)
    })
  })

  describe("hubFetch", () => {
    it("keeps hub calls hub-local and uses cookie credentials", async () => {
      setLocation("example.com", "/d/dev_x/")
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
      await hubFetch("/api/network-info")

      expect(fetchSpy.mock.calls[0][0]).toBe("/api/network-info")
      const init = fetchSpy.mock.calls[0][1]
      const headers = init?.headers as Headers
      expect(init?.credentials).toBe("same-origin")
      expect(headers.get("Authorization")).toBeNull()
      expect(headers.get("X-Cogpit-Client")).toBe("1")
    })
  })

  describe("authUrl", () => {
    it("never places browser credentials in URLs", () => {
      setHostname("example.com")
      localStorage.setItem("cogpit-network-token", "must-not-leak")
      expect(authUrl("/api/events?foo=bar")).toBe("/api/events?foo=bar")
      expect(authUrl("/api/events?foo=bar")).not.toContain("token=")
    })

    it("still applies the active device prefix", () => {
      setLocation("example.com", "/d/dev_x/")
      expect(authUrl("/api/events")).toBe("/hub/dev_x/api/events")
    })
  })
})
