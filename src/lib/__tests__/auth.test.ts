import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  isRemoteClient,
  clearToken,
  checkAuthSession,
  logoutSession,
  authFetch,
  hubFetch,
  authUrl,
  getServerEdition,
  getServerHello,
  refreshServerHello,
  __resetServerHelloForTest,
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
    __resetServerHelloForTest()
  })

  afterEach(() => setHostname("localhost"))

  describe("getServerHello", () => {
    it("reports the open first-admin bootstrap from the same cached probe", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ edition: "team", needsBootstrap: true }), { status: 200 }),
      )

      await expect(getServerHello()).resolves.toEqual({ edition: "team", needsBootstrap: true })
      await expect(getServerEdition()).resolves.toBe("team")
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    it("treats a missing or non-boolean needsBootstrap as closed", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ edition: "team", needsBootstrap: "yes" }), { status: 200 }),
      )
      await expect(getServerHello()).resolves.toEqual({ edition: "team", needsBootstrap: false })
    })

    it("never reports a bootstrap for a personal server", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ needsBootstrap: true }), { status: 200 }),
      )
      await expect(getServerHello()).resolves.toEqual({ edition: "personal", needsBootstrap: false })
    })

    it("refreshes the cache after the bootstrap closes", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ edition: "team", needsBootstrap: true }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ edition: "team", needsBootstrap: false }), { status: 200 }),
        )

      await expect(getServerHello()).resolves.toMatchObject({ needsBootstrap: true })
      await expect(refreshServerHello()).resolves.toMatchObject({ needsBootstrap: false })
      // The refreshed answer replaces the cache — later readers see it too.
      await expect(getServerHello()).resolves.toMatchObject({ needsBootstrap: false })
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })
  })

  describe("getServerEdition", () => {
    it("fetches /api/hello once and caches the result", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ edition: "team" }), { status: 200 }),
      )

      await expect(getServerEdition()).resolves.toBe("team")
      await expect(getServerEdition()).resolves.toBe("team")
      expect(fetchSpy).toHaveBeenCalledOnce()
      expect(fetchSpy).toHaveBeenCalledWith("/api/hello", expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
      }))
    })

    it("shares one in-flight request between concurrent callers", async () => {
      let resolveHello!: (r: Response) => void
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockReturnValue(
        new Promise((resolve) => { resolveHello = resolve }),
      )

      const first = getServerEdition()
      const second = getServerEdition()
      resolveHello(new Response(JSON.stringify({ edition: "team" }), { status: 200 }))

      await expect(first).resolves.toBe("team")
      await expect(second).resolves.toBe("team")
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    it("treats a failed probe as personal without caching the failure", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce(new Response(JSON.stringify({ edition: "team" }), { status: 200 }))

      await expect(getServerEdition()).resolves.toBe("personal")
      await expect(getServerEdition()).resolves.toBe("team")
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it("treats a missing or unknown edition value as personal", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ app: "cogpit" }), { status: 200 }),
      )
      await expect(getServerEdition()).resolves.toBe("personal")
    })
  })

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

    it("checks the session endpoint for local clients once the server is known team edition", async () => {
      setHostname("localhost")
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify({ edition: "team" }), { status: 200 }))
        .mockResolvedValueOnce(new Response("{}", { status: 200 }))

      await getServerEdition()
      await expect(checkAuthSession()).resolves.toBe(true)
      expect(fetchSpy).toHaveBeenLastCalledWith("/api/auth/session", expect.objectContaining({
        credentials: "same-origin",
      }))
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

    it("re-probes the edition after a failed hello when a local request gets a 401, and gates if it resolves team", async () => {
      setHostname("localhost")
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new Error("offline")) // boot hello probe fails → assumed personal, uncached
        .mockResolvedValueOnce(new Response("", { status: 401 })) // the gated API request
        .mockResolvedValueOnce(new Response(JSON.stringify({ edition: "team" }), { status: 200 })) // re-probe
      await expect(getServerEdition()).resolves.toBe("personal")
      const handler = vi.fn()
      window.addEventListener("cogpit-auth-required", handler)

      await expect(authFetch("/api/secure")).rejects.toThrow("Authentication required")
      expect(handler).toHaveBeenCalledOnce()
      expect(fetchSpy.mock.calls[2][0]).toBe("/api/hello")
      window.removeEventListener("cogpit-auth-required", handler)
    })

    it("passes the 401 through when the re-probe still cannot identify a team server", async () => {
      setHostname("localhost")
      vi.spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce(new Response("", { status: 401 }))
        .mockRejectedValueOnce(new Error("still offline"))
      await expect(getServerEdition()).resolves.toBe("personal")
      const handler = vi.fn()
      window.addEventListener("cogpit-auth-required", handler)

      const res = await authFetch("/api/secure")
      expect(res.status).toBe(401)
      expect(handler).not.toHaveBeenCalled()
      window.removeEventListener("cogpit-auth-required", handler)
    })

    it("does not re-probe on a local 401 when the server is positively known personal", async () => {
      setHostname("localhost")
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify({ edition: "personal" }), { status: 200 }))
        .mockResolvedValueOnce(new Response("", { status: 401 }))
      await expect(getServerEdition()).resolves.toBe("personal")

      const res = await authFetch("/api/secure")
      expect(res.status).toBe(401)
      expect(fetchSpy).toHaveBeenCalledTimes(2) // hello + request — no re-probe
    })

    it("fires auth-required on a local 401 once the server is known team edition", async () => {
      setHostname("localhost")
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify({ edition: "team" }), { status: 200 }))
        .mockResolvedValue(new Response("", { status: 401 }))
      await getServerEdition()
      const handler = vi.fn()
      window.addEventListener("cogpit-auth-required", handler)

      await expect(authFetch("/api/secure")).rejects.toThrow("Authentication required")
      expect(handler).toHaveBeenCalledOnce()
      window.removeEventListener("cogpit-auth-required", handler)
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

    async function captureUnreachable(response: Response): Promise<CustomEvent[]> {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(response)
      const events: CustomEvent[] = []
      const handler = (event: Event) => void events.push(event as CustomEvent)
      window.addEventListener("cogpit-device-unreachable", handler)
      await authFetch("/api/data")
      window.removeEventListener("cogpit-device-unreachable", handler)
      return events
    }

    it("dispatches device-unreachable when the hub could not reach the device", async () => {
      setLocation("localhost", "/d/dev_x/")
      const events = await captureUnreachable(new Response("bad gateway", {
        status: 502,
        headers: { "X-Cogpit-Device": "dev_x", "X-Cogpit-Hub-Error": "DEVICE_UNREACHABLE" },
      }))
      expect(events[0].detail).toEqual({ deviceId: "dev_x", reason: "DEVICE_UNREACHABLE" })
    })

    it("reports a rejected hub credential as its own reason", async () => {
      setLocation("localhost", "/d/dev_x/")
      const events = await captureUnreachable(new Response("bad gateway", {
        status: 502,
        headers: { "X-Cogpit-Device": "dev_x", "X-Cogpit-Hub-Error": "DEVICE_AUTH_FAILED" },
      }))
      expect(events[0].detail).toEqual({ deviceId: "dev_x", reason: "DEVICE_AUTH_FAILED" })
    })

    it("stays quiet when the DEVICE itself answers 502 — it is still reachable", async () => {
      setLocation("localhost", "/d/dev_x/")
      // The hub pipes a device-origin error through verbatim and stamps
      // X-Cogpit-Device on it, so only the absent hub-error header separates
      // "the CLI runtime is down" from "the box is offline".
      const events = await captureUnreachable(new Response(
        JSON.stringify({ available: false, error: "Claude runtime unavailable" }),
        { status: 502, headers: { "X-Cogpit-Device": "dev_x" } },
      ))
      expect(events).toEqual([])
    })

    it("stays quiet when the hub only reports changed connection settings", async () => {
      setLocation("localhost", "/d/dev_x/")
      const events = await captureUnreachable(new Response("changed", {
        status: 502,
        headers: { "X-Cogpit-Device": "dev_x", "X-Cogpit-Hub-Error": "DEVICE_CONNECTION_CHANGED" },
      }))
      expect(events).toEqual([])
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
