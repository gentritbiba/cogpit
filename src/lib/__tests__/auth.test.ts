import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  isRemoteClient,
  getToken,
  setToken,
  clearToken,
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
    vi.restoreAllMocks()
  })

  afterEach(() => {
    // Reset to localhost
    setHostname("localhost")
  })

  // ── isRemoteClient ──────────────────────────────────────────────────────

  describe("isRemoteClient", () => {
    it("returns false for localhost", () => {
      setHostname("localhost")
      expect(isRemoteClient()).toBe(false)
    })

    it("returns false for 127.0.0.1", () => {
      setHostname("127.0.0.1")
      expect(isRemoteClient()).toBe(false)
    })

    it("returns false for ::1", () => {
      setHostname("::1")
      expect(isRemoteClient()).toBe(false)
    })

    it("returns true for a remote hostname", () => {
      setHostname("example.com")
      expect(isRemoteClient()).toBe(true)
    })

    it("returns true for an IP address", () => {
      setHostname("192.168.1.100")
      expect(isRemoteClient()).toBe(true)
    })
  })

  // ── getToken / setToken / clearToken ────────────────────────────────────

  describe("getToken", () => {
    it("returns null when no token is stored", () => {
      expect(getToken()).toBeNull()
    })

    it("returns the stored token", () => {
      localStorage.setItem("cogpit-network-token", "abc123")
      expect(getToken()).toBe("abc123")
    })
  })

  describe("setToken", () => {
    it("stores the token in localStorage", () => {
      setToken("my-token")
      expect(localStorage.getItem("cogpit-network-token")).toBe("my-token")
    })

    it("dispatches cogpit-auth-changed event", () => {
      const handler = vi.fn()
      window.addEventListener("cogpit-auth-changed", handler)
      setToken("t")
      window.removeEventListener("cogpit-auth-changed", handler)
      expect(handler).toHaveBeenCalledOnce()
    })
  })

  describe("clearToken", () => {
    it("removes the token from localStorage", () => {
      localStorage.setItem("cogpit-network-token", "t")
      clearToken()
      expect(localStorage.getItem("cogpit-network-token")).toBeNull()
    })
  })

  // ── authFetch ───────────────────────────────────────────────────────────

  describe("authFetch", () => {
    it("passes through to fetch for local clients (no token, with client header)", async () => {
      setHostname("localhost")
      const mockResponse = new Response("ok", { status: 200 })
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse)

      const res = await authFetch("/api/test")
      const [url, init] = fetchSpy.mock.calls[0]
      expect(url).toBe("/api/test")
      const headers = init?.headers as Headers
      // No bearer token for a local client, but the CSRF guard header is set.
      expect(headers.get("Authorization")).toBeNull()
      expect(headers.get("X-Cogpit-Client")).toBe("1")
      expect(res).toBe(mockResponse)
    })

    it("always sets X-Cogpit-Client for remote clients", async () => {
      setHostname("example.com")
      setToken("tok")
      const mockResponse = new Response("ok", { status: 200 })
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse)

      await authFetch("/api/data")
      const [, init] = fetchSpy.mock.calls[0]
      const headers = init?.headers as Headers
      expect(headers.get("X-Cogpit-Client")).toBe("1")
    })

    it("applies the device prefix when the URL carries /d/<id>", async () => {
      setLocation("example.com", "/d/dev_x/")
      setToken("tok")
      const mockResponse = new Response("ok", { status: 200 })
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse)

      await authFetch("/api/data")
      expect(fetchSpy.mock.calls[0][0]).toBe("/hub/dev_x/api/data")
    })

    it("does not prefix /api/hub/* even on a remote device", async () => {
      setLocation("example.com", "/d/dev_x/")
      setToken("tok")
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))

      await authFetch("/api/hub/devices")
      expect(fetchSpy.mock.calls[0][0]).toBe("/api/hub/devices")
    })

    it("does not prefix URLs on the local device", async () => {
      setLocation("localhost", "/-Users-foo/sess")
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))

      await authFetch("/api/data")
      expect(fetchSpy.mock.calls[0][0]).toBe("/api/data")
    })

    it("dispatches cogpit-device-unreachable on 502 with X-Cogpit-Device and still returns the response", async () => {
      setLocation("localhost", "/d/dev_x/")
      const mockResponse = new Response("bad gateway", {
        status: 502,
        headers: { "X-Cogpit-Device": "dev_x" },
      })
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse)

      const handler = vi.fn()
      window.addEventListener("cogpit-device-unreachable", handler as EventListener)

      const res = await authFetch("/api/data")
      expect(res.status).toBe(502)
      expect(handler).toHaveBeenCalledOnce()
      const evt = handler.mock.calls[0][0] as CustomEvent
      expect(evt.detail).toEqual({ deviceId: "dev_x" })

      window.removeEventListener("cogpit-device-unreachable", handler as EventListener)
    })

    it("does not dispatch cogpit-device-unreachable on a 502 without the device header", async () => {
      setHostname("localhost")
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x", { status: 502 }))
      const handler = vi.fn()
      window.addEventListener("cogpit-device-unreachable", handler as EventListener)

      const res = await authFetch("/api/data")
      expect(res.status).toBe(502)
      expect(handler).not.toHaveBeenCalled()

      window.removeEventListener("cogpit-device-unreachable", handler as EventListener)
    })
  })

  // ── hubFetch ──────────────────────────────────────────────────────────

  describe("hubFetch", () => {
    it("never applies the device prefix, even on a remote device", async () => {
      setLocation("example.com", "/d/dev_x/")
      setToken("tok")
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))

      await hubFetch("/api/network-info")
      // authFetch would route this to /hub/dev_x/api/network-info; hubFetch keeps it hub-local.
      expect(fetchSpy.mock.calls[0][0]).toBe("/api/network-info")
    })

    it("still injects the bearer token and client header for remote clients", async () => {
      setLocation("example.com", "/d/dev_x/")
      setToken("secret")
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))

      await hubFetch("/api/network-info")
      const [, init] = fetchSpy.mock.calls[0]
      const headers = init?.headers as Headers
      expect(headers.get("Authorization")).toBe("Bearer secret")
      expect(headers.get("X-Cogpit-Client")).toBe("1")
    })

    it("rejects with auth-required event when remote and no token", async () => {
      setHostname("example.com")
      const handler = vi.fn()
      window.addEventListener("cogpit-auth-required", handler)

      await expect(authFetch("/api/test")).rejects.toThrow("Authentication required")
      expect(handler).toHaveBeenCalledOnce()

      window.removeEventListener("cogpit-auth-required", handler)
    })

    it("injects Bearer token header for remote clients", async () => {
      setHostname("example.com")
      setToken("secret")
      const mockResponse = new Response("ok", { status: 200 })
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse)

      await authFetch("/api/data")
      const [, init] = fetchSpy.mock.calls[0]
      const headers = init?.headers as Headers
      expect(headers.get("Authorization")).toBe("Bearer secret")
    })

    it("clears token and fires auth-required on 401", async () => {
      setHostname("example.com")
      setToken("old-token")
      const mockResponse = new Response("unauthorized", { status: 401 })
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse)

      const handler = vi.fn()
      window.addEventListener("cogpit-auth-required", handler)

      await expect(authFetch("/api/secure")).rejects.toThrow("Authentication required")
      expect(getToken()).toBeNull()
      expect(handler).toHaveBeenCalledOnce()

      window.removeEventListener("cogpit-auth-required", handler)
    })

    it("merges with existing init options", async () => {
      setHostname("example.com")
      setToken("tok")
      const mockResponse = new Response("ok", { status: 200 })
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse)

      await authFetch("/api/data", { method: "POST", body: "hello" })
      const [, init] = fetchSpy.mock.calls[0]
      expect(init?.method).toBe("POST")
      expect(init?.body).toBe("hello")
    })

    it("preserves existing headers while adding Authorization", async () => {
      setHostname("example.com")
      setToken("my-token")
      const mockResponse = new Response("ok", { status: 200 })
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse)

      await authFetch("/api/data", {
        headers: { "Content-Type": "application/json", "X-Custom": "value" },
      })
      const [, init] = fetchSpy.mock.calls[0]
      const headers = init?.headers as Headers
      expect(headers.get("Authorization")).toBe("Bearer my-token")
      expect(headers.get("Content-Type")).toBe("application/json")
      expect(headers.get("X-Custom")).toBe("value")
    })

    it("returns successful non-401 responses without clearing token", async () => {
      setHostname("example.com")
      setToken("good-token")
      const mockResponse = new Response("ok", { status: 200 })
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse)

      const res = await authFetch("/api/data")
      expect(res.status).toBe(200)
      expect(getToken()).toBe("good-token") // token preserved
    })
  })

  // ── authUrl ─────────────────────────────────────────────────────────────

  describe("authUrl", () => {
    it("returns the URL unchanged for local clients", () => {
      setHostname("localhost")
      expect(authUrl("/api/stream")).toBe("/api/stream")
    })

    it("fires auth-required and returns URL unchanged when remote with no token", () => {
      setHostname("example.com")
      const handler = vi.fn()
      window.addEventListener("cogpit-auth-required", handler)

      expect(authUrl("/api/stream")).toBe("/api/stream")
      expect(handler).toHaveBeenCalledOnce()

      window.removeEventListener("cogpit-auth-required", handler)
    })

    it("appends token as query param with ? separator", () => {
      setHostname("example.com")
      setToken("my-token")
      expect(authUrl("/api/events")).toBe("/api/events?token=my-token")
    })

    it("appends token with & separator when URL already has query params", () => {
      setHostname("example.com")
      setToken("tok")
      expect(authUrl("/api/events?foo=bar")).toBe("/api/events?foo=bar&token=tok")
    })

    it("encodes special characters in the token", () => {
      setHostname("example.com")
      setToken("a b&c=d")
      expect(authUrl("/api/events")).toBe("/api/events?token=a%20b%26c%3Dd")
    })
  })
})
