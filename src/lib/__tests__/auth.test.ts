import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  isRemoteClient,
  getToken,
  setToken,
  clearToken,
  authFetch,
  authUrl,
} from "@/lib/auth"

function setHostname(hostname: string) {
  Object.defineProperty(window, "location", {
    value: { hostname },
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
    it("passes through to fetch for local clients", async () => {
      setHostname("localhost")
      const mockResponse = new Response("ok", { status: 200 })
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse)

      const res = await authFetch("/api/test")
      expect(fetchSpy).toHaveBeenCalledWith("/api/test", undefined)
      expect(res).toBe(mockResponse)
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
