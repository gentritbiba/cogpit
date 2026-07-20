// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Mocks ─────────────────────────────────────────────────────────────────
// registry + device-client are authored in parallel; we mock them to the plan
// contracts so these route tests stand alone.

vi.mock("../../helpers", () => ({
  sendJson: (res: { statusCode: number; setHeader: (n: string, v: string) => void; end: (d: string) => void }, status: number, data: unknown) => {
    res.statusCode = status
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(data))
  },
}))

vi.mock("../../routes/hello", () => ({
  getInstanceId: () => "self-instance",
  registerHelloRoutes: vi.fn(),
}))

vi.mock("../../hub/registry", () => ({
  getDevice: vi.fn(),
  listDevices: vi.fn(),
  addDevice: vi.fn(),
  updateDevice: vi.fn(),
  removeDevice: vi.fn(),
  validateDeviceHost: vi.fn(),
  setDeviceRuntime: vi.fn(),
}))

vi.mock("../../hub/device-client", () => {
  class DeviceAuthError extends Error {}
  class DeviceUnreachableError extends Error {}
  return {
    getDeviceToken: vi.fn(),
    invalidateDeviceToken: vi.fn(),
    DeviceAuthError,
    DeviceUnreachableError,
  }
})

import {
  getDevice,
  listDevices,
  addDevice,
  updateDevice,
  removeDevice,
  validateDeviceHost,
  setDeviceRuntime,
} from "../../hub/registry"
import {
  getDeviceToken,
  invalidateDeviceToken,
  DeviceAuthError,
  DeviceUnreachableError,
} from "../../hub/device-client"
import type { UseFn, Middleware } from "../../helpers"
import { registerDeviceRoutes } from "../../routes/devices"

const mockedGetDevice = vi.mocked(getDevice)
const mockedListDevices = vi.mocked(listDevices)
const mockedAddDevice = vi.mocked(addDevice)
const mockedUpdateDevice = vi.mocked(updateDevice)
const mockedRemoveDevice = vi.mocked(removeDevice)
const mockedValidateDeviceHost = vi.mocked(validateDeviceHost)
const mockedSetDeviceRuntime = vi.mocked(setDeviceRuntime)
const mockedGetDeviceToken = vi.mocked(getDeviceToken)
const mockedInvalidateDeviceToken = vi.mocked(invalidateDeviceToken)

// ── fetch helpers ──────────────────────────────────────────────────────────

interface FakeResOpts {
  status?: number
  contentType?: string
  json?: unknown
  jsonThrows?: boolean
}

function fakeResponse(opts: FakeResOpts = {}) {
  const status = opts.status ?? 200
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? (opts.contentType ?? "application/json") : null,
    },
    json: async () => {
      if (opts.jsonThrows) throw new Error("bad json")
      return opts.json
    },
  }
}

const helloOk = { app: "cogpit", hubApi: 1, name: "remote-mac", instanceId: "remote-instance" }

function mockFetch() {
  const fn = vi.fn()
  vi.stubGlobal("fetch", fn)
  return fn
}

// ── mock req/res ────────────────────────────────────────────────────────────

function createMockReqRes(
  method: string,
  url: string,
  body?: unknown,
  // Mutations require the X-Cogpit-Client CSRF header; default it in so the
  // common-case tests exercise the real (authorized) path. Pass {} to omit it.
  headers: Record<string, string> = { "x-cogpit-client": "1" },
) {
  const dataHandlers: ((chunk: Buffer) => void)[] = []
  const endHandlers: (() => void)[] = []
  let statusCode = 200
  let endData = ""
  let resolveDone: () => void
  const done = new Promise<void>((r) => { resolveDone = r })
  const req = {
    method,
    url,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "data") dataHandlers.push(handler as (chunk: Buffer) => void)
      if (event === "end") endHandlers.push(handler as () => void)
      return req
    }),
    socket: { remoteAddress: "192.168.1.100" },
    headers,
  }
  const res = {
    get statusCode() { return statusCode },
    set statusCode(v: number) { statusCode = v },
    setHeader: vi.fn(),
    end: vi.fn((data?: string) => { endData = data || ""; resolveDone() }),
    _getData: () => endData,
    _getStatus: () => statusCode,
  }
  const next = vi.fn()
  const sendBody = () => {
    if (body !== undefined) {
      const raw = typeof body === "string" ? body : JSON.stringify(body)
      for (const h of dataHandlers) h(Buffer.from(raw))
    }
    for (const h of endHandlers) h()
  }
  return { req, res, next, sendBody, done }
}

function getHandler(): Middleware {
  const handlers = new Map<string, Middleware>()
  const use: UseFn = (path, handler) => { handlers.set(path, handler) }
  registerDeviceRoutes(use)
  return handlers.get("/api/hub/devices")!
}

/** Drive a body-reading handler: invoke, flush the body, await the response. */
async function drive(method: string, url: string, body?: unknown, headers?: Record<string, string>) {
  const handler = getHandler()
  const { req, res, next, sendBody, done } = createMockReqRes(method, url, body, headers)
  handler(req as never, res as never, next)
  sendBody()
  await done
  return { res, next }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  mockedValidateDeviceHost.mockReturnValue(null)
})

// ── GET /api/hub/devices ────────────────────────────────────────────────────

describe("GET /api/hub/devices", () => {
  it("returns the sanitized device list", () => {
    const handler = getHandler()
    const devices = [{ id: "dev_1", name: "mac", host: "10.0.0.2", port: 19384, auth: "password", addedAt: 1 }]
    mockedListDevices.mockReturnValue(devices as never)
    const { req, res, next } = createMockReqRes("GET", "/")

    handler(req as never, res as never, next)

    expect(JSON.parse(res._getData())).toEqual({ devices })
    expect(res._getStatus()).toBe(200)
  })

  it("calls next for unsupported methods on the collection", () => {
    const handler = getHandler()
    const { req, res, next } = createMockReqRes("PUT", "/")
    handler(req as never, res as never, next)
    expect(next).toHaveBeenCalled()
  })
})

// ── POST /api/hub/devices/probe ─────────────────────────────────────────────

describe("POST /api/hub/devices/probe", () => {
  it("rejects a missing host", async () => {
    const { res } = await drive("POST", "/probe", {})
    expect(res._getStatus()).toBe(400)
    expect(JSON.parse(res._getData()).code).toBe("BAD_REQUEST")
  })

  it("rejects a host that fails validateDeviceHost before fetching (SSRF guard)", async () => {
    const fetchFn = mockFetch()
    mockedValidateDeviceHost.mockReturnValue("Loopback hosts are not allowed")

    const { res } = await drive("POST", "/probe", { host: "127.0.0.1" })

    expect(res._getStatus()).toBe(400)
    expect(JSON.parse(res._getData()).code).toBe("INVALID_HOST")
    expect(fetchFn).not.toHaveBeenCalled()
    expect(mockedValidateDeviceHost).toHaveBeenCalledWith("127.0.0.1", false)
  })

  it("threads allowLocalTunnel through to validateDeviceHost when probing", async () => {
    mockFetch().mockResolvedValueOnce(fakeResponse({ json: helloOk }))

    const { res } = await drive("POST", "/probe", { host: "127.0.0.1", allowLocalTunnel: true })

    expect(res._getStatus()).toBe(200)
    expect(mockedValidateDeviceHost).toHaveBeenCalledWith("127.0.0.1", true)
  })

  it("returns ok:true with the hello payload for a cogpit device", async () => {
    const fetchFn = mockFetch()
    fetchFn.mockResolvedValueOnce(fakeResponse({ json: helloOk }))

    const { res } = await drive("POST", "/probe", { host: "10.0.0.2", port: 19384 })

    const body = JSON.parse(res._getData())
    expect(body).toEqual({ ok: true, hello: helloOk })
    expect(fetchFn).toHaveBeenCalledWith("http://10.0.0.2:19384/api/hello", expect.anything())
  })

  it("returns UNREACHABLE when the fetch rejects", async () => {
    const fetchFn = mockFetch()
    fetchFn.mockRejectedValueOnce(new Error("ECONNREFUSED"))

    const { res } = await drive("POST", "/probe", { host: "10.0.0.2" })

    expect(JSON.parse(res._getData())).toMatchObject({ ok: false, code: "UNREACHABLE" })
  })

  it("returns LEGACY_NO_HELLO for a 200 text/html SPA fallback", async () => {
    const fetchFn = mockFetch()
    fetchFn.mockResolvedValueOnce(fakeResponse({ status: 200, contentType: "text/html" }))

    const { res } = await drive("POST", "/probe", { host: "10.0.0.2" })

    expect(JSON.parse(res._getData())).toMatchObject({ ok: false, code: "LEGACY_NO_HELLO" })
  })

  it("returns NOT_COGPIT for a non-JSON response", async () => {
    const fetchFn = mockFetch()
    fetchFn.mockResolvedValueOnce(fakeResponse({ status: 404, contentType: "text/plain" }))

    const { res } = await drive("POST", "/probe", { host: "10.0.0.2" })

    expect(JSON.parse(res._getData())).toMatchObject({ ok: false, code: "NOT_COGPIT" })
  })

  it("returns NOT_COGPIT for JSON that is not a cogpit hello", async () => {
    const fetchFn = mockFetch()
    fetchFn.mockResolvedValueOnce(fakeResponse({ json: { app: "something-else" } }))

    const { res } = await drive("POST", "/probe", { host: "10.0.0.2" })

    expect(JSON.parse(res._getData())).toMatchObject({ ok: false, code: "NOT_COGPIT" })
  })

  it("returns SELF_ADD when the device is this hub", async () => {
    const fetchFn = mockFetch()
    fetchFn.mockResolvedValueOnce(fakeResponse({ json: { app: "cogpit", instanceId: "self-instance" } }))

    const { res } = await drive("POST", "/probe", { host: "10.0.0.2" })

    expect(JSON.parse(res._getData())).toMatchObject({ ok: false, code: "SELF_ADD" })
  })
})

// ── POST /api/hub/devices (add) ─────────────────────────────────────────────

describe("POST /api/hub/devices", () => {
  it("rejects an invalid host before probing", async () => {
    const fetchFn = mockFetch()
    mockedValidateDeviceHost.mockReturnValue("Loopback hosts are not allowed")

    const { res } = await drive("POST", "/", { host: "127.0.0.1", password: "pw" })

    expect(res._getStatus()).toBe(400)
    expect(JSON.parse(res._getData()).code).toBe("INVALID_HOST")
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("returns 502 UNREACHABLE when the probe fails", async () => {
    const fetchFn = mockFetch()
    fetchFn.mockRejectedValueOnce(new Error("timeout"))

    const { res } = await drive("POST", "/", { host: "10.0.0.2", password: "pw" })

    expect(res._getStatus()).toBe(502)
    expect(JSON.parse(res._getData()).code).toBe("UNREACHABLE")
  })

  it("saves a password device after a successful probe + verify", async () => {
    const fetchFn = mockFetch()
    fetchFn
      .mockResolvedValueOnce(fakeResponse({ json: helloOk }))                       // probe
      .mockResolvedValueOnce(fakeResponse({ json: { valid: true, token: "tok" } })) // verify
    mockedAddDevice.mockReturnValue({
      id: "dev_new", name: "remote-mac", host: "10.0.0.2", port: 19384,
      auth: "password", password: "pw", addedAt: 123,
    } as never)

    const { res } = await drive("POST", "/", { host: "10.0.0.2", password: "pw" })

    expect(res._getStatus()).toBe(201)
    const body = JSON.parse(res._getData())
    expect(body.device.id).toBe("dev_new")
    expect(body.device.password).toBeUndefined()
    expect(mockedAddDevice).toHaveBeenCalledWith(expect.objectContaining({ auth: "password", password: "pw" }))
    expect(mockedSetDeviceRuntime).toHaveBeenCalledWith("dev_new", expect.objectContaining({ authState: "ok" }))
  })

  it("surfaces BAD_PASSWORD from the device", async () => {
    const fetchFn = mockFetch()
    fetchFn
      .mockResolvedValueOnce(fakeResponse({ json: helloOk }))
      .mockResolvedValueOnce(fakeResponse({ status: 401, json: { valid: false } }))

    const { res } = await drive("POST", "/", { host: "10.0.0.2", password: "wrong" })

    expect(res._getStatus()).toBe(400)
    expect(JSON.parse(res._getData()).code).toBe("BAD_PASSWORD")
    expect(mockedAddDevice).not.toHaveBeenCalled()
  })

  it("surfaces NETWORK_DISABLED (device 403)", async () => {
    const fetchFn = mockFetch()
    fetchFn
      .mockResolvedValueOnce(fakeResponse({ json: helloOk }))
      .mockResolvedValueOnce(fakeResponse({ status: 403 }))

    const { res } = await drive("POST", "/", { host: "10.0.0.2", password: "pw" })

    expect(JSON.parse(res._getData()).code).toBe("NETWORK_DISABLED")
  })

  it("surfaces NOT_CONFIGURED (device 503)", async () => {
    const fetchFn = mockFetch()
    fetchFn
      .mockResolvedValueOnce(fakeResponse({ json: helloOk }))
      .mockResolvedValueOnce(fakeResponse({ status: 503 }))

    const { res } = await drive("POST", "/", { host: "10.0.0.2", password: "pw" })

    expect(JSON.parse(res._getData()).code).toBe("NOT_CONFIGURED")
  })

  it("requires a password unless allowLocalTunnel is set", async () => {
    mockFetch().mockResolvedValueOnce(fakeResponse({ json: helloOk }))

    const { res } = await drive("POST", "/", { host: "10.0.0.2" })

    expect(res._getStatus()).toBe(400)
    expect(JSON.parse(res._getData()).code).toBe("PASSWORD_REQUIRED")
  })

  it("registers a tunnel device with auth:none when allowLocalTunnel is set", async () => {
    mockFetch().mockResolvedValueOnce(fakeResponse({ json: helloOk }))
    mockedAddDevice.mockReturnValue({
      id: "dev_tunnel", name: "remote-mac", host: "127.0.0.1", port: 19384, auth: "none", addedAt: 1,
    } as never)

    const { res } = await drive("POST", "/", { host: "127.0.0.1", allowLocalTunnel: true })

    expect(res._getStatus()).toBe(201)
    expect(mockedAddDevice).toHaveBeenCalledWith(expect.objectContaining({ auth: "none" }))
    expect(mockedValidateDeviceHost).toHaveBeenCalledWith("127.0.0.1", true)
  })
})

// ── PATCH /api/hub/devices/:id ──────────────────────────────────────────────

describe("PATCH /api/hub/devices/:id", () => {
  it("404s for an unknown device", async () => {
    mockedGetDevice.mockReturnValue(undefined)
    const { res } = await drive("PATCH", "/dev_missing", { name: "x" })
    expect(res._getStatus()).toBe(404)
    expect(JSON.parse(res._getData()).code).toBe("UNKNOWN_DEVICE")
  })

  it("renames without re-probing or invalidating the token", async () => {
    const fetchFn = mockFetch()
    mockedGetDevice.mockReturnValue({
      id: "dev_1", name: "old", host: "10.0.0.2", port: 19384, auth: "password", password: "pw", addedAt: 1,
    } as never)

    const { res } = await drive("PATCH", "/dev_1", { name: "new" })

    expect(res._getStatus()).toBe(200)
    expect(JSON.parse(res._getData()).device.name).toBe("new")
    expect(JSON.parse(res._getData()).device.password).toBeUndefined()
    expect(mockedUpdateDevice).toHaveBeenCalledWith("dev_1", expect.objectContaining({ name: "new" }))
    expect(fetchFn).not.toHaveBeenCalled()
    expect(mockedInvalidateDeviceToken).not.toHaveBeenCalled()
  })

  it("re-probes and invalidates the token on a host change", async () => {
    const fetchFn = mockFetch()
    fetchFn.mockResolvedValueOnce(fakeResponse({ json: helloOk }))
    mockedGetDevice.mockReturnValue({
      id: "dev_1", name: "mac", host: "10.0.0.2", port: 19384, auth: "none", addedAt: 1,
    } as never)

    const { res } = await drive("PATCH", "/dev_1", { host: "10.0.0.9" })

    expect(res._getStatus()).toBe(200)
    expect(mockedInvalidateDeviceToken).toHaveBeenCalledWith("dev_1")
    expect(mockedValidateDeviceHost).toHaveBeenCalledWith("10.0.0.9", true)
    expect(fetchFn).toHaveBeenCalledWith("http://10.0.0.9:19384/api/hello", expect.anything())
    expect(mockedUpdateDevice).toHaveBeenCalledWith("dev_1", expect.objectContaining({ host: "10.0.0.9" }))
  })

  it("surfaces a bad password when re-verifying on password change", async () => {
    const fetchFn = mockFetch()
    fetchFn
      .mockResolvedValueOnce(fakeResponse({ json: helloOk }))              // re-probe
      .mockResolvedValueOnce(fakeResponse({ status: 401, json: { valid: false } })) // verify
    mockedGetDevice.mockReturnValue({
      id: "dev_1", name: "mac", host: "10.0.0.2", port: 19384, auth: "password", password: "old", addedAt: 1,
    } as never)

    const { res } = await drive("PATCH", "/dev_1", { password: "wrong" })

    expect(res._getStatus()).toBe(400)
    expect(JSON.parse(res._getData()).code).toBe("BAD_PASSWORD")
    expect(mockedInvalidateDeviceToken).toHaveBeenCalledWith("dev_1")
    expect(mockedUpdateDevice).not.toHaveBeenCalled()
  })
})

// ── DELETE /api/hub/devices/:id ─────────────────────────────────────────────

describe("DELETE /api/hub/devices/:id", () => {
  it("404s for an unknown device", async () => {
    mockedGetDevice.mockReturnValue(undefined)
    const { res } = await drive("DELETE", "/dev_missing")
    expect(res._getStatus()).toBe(404)
    expect(mockedRemoveDevice).not.toHaveBeenCalled()
  })

  it("removes the device and invalidates its token", async () => {
    mockedGetDevice.mockReturnValue({
      id: "dev_1", name: "mac", host: "10.0.0.2", port: 19384, auth: "password", addedAt: 1,
    } as never)
    mockedRemoveDevice.mockResolvedValue(true)

    const { res } = await drive("DELETE", "/dev_1")

    expect(res._getStatus()).toBe(200)
    expect(JSON.parse(res._getData()).success).toBe(true)
    expect(mockedRemoveDevice).toHaveBeenCalledWith("dev_1")
    expect(mockedInvalidateDeviceToken).toHaveBeenCalledWith("dev_1")
  })
})

// ── POST /api/hub/devices/:id/test ──────────────────────────────────────────

describe("POST /api/hub/devices/:id/test", () => {
  it("404s for an unknown device", async () => {
    mockedGetDevice.mockReturnValue(undefined)
    const { res } = await drive("POST", "/dev_missing/test")
    expect(res._getStatus()).toBe(404)
  })

  it("reports ok when reachable and the token mints", async () => {
    const fetchFn = mockFetch()
    fetchFn.mockResolvedValueOnce(fakeResponse({ json: helloOk }))
    mockedGetDevice.mockReturnValue({
      id: "dev_1", name: "mac", host: "10.0.0.2", port: 19384, auth: "password", password: "pw", addedAt: 1,
    } as never)
    mockedGetDeviceToken.mockResolvedValue("tok")

    const { res } = await drive("POST", "/dev_1/test")

    const body = JSON.parse(res._getData())
    expect(body).toMatchObject({ ok: true, reachable: true, authState: "ok" })
    expect(mockedSetDeviceRuntime).toHaveBeenCalledWith("dev_1", expect.objectContaining({ authState: "ok" }))
  })

  it("reports bad-password when the token mint throws DeviceAuthError", async () => {
    const fetchFn = mockFetch()
    fetchFn.mockResolvedValueOnce(fakeResponse({ json: helloOk }))
    mockedGetDevice.mockReturnValue({
      id: "dev_1", name: "mac", host: "10.0.0.2", port: 19384, auth: "password", password: "pw", addedAt: 1,
    } as never)
    mockedGetDeviceToken.mockRejectedValue(new DeviceAuthError("bad"))

    const { res } = await drive("POST", "/dev_1/test")

    expect(JSON.parse(res._getData())).toMatchObject({ ok: false, authState: "bad-password", code: "BAD_PASSWORD" })
    expect(mockedSetDeviceRuntime).toHaveBeenCalledWith("dev_1", expect.objectContaining({ authState: "bad-password" }))
  })

  it("reports unreachable when the probe fails", async () => {
    const fetchFn = mockFetch()
    fetchFn.mockRejectedValueOnce(new Error("down"))
    mockedGetDevice.mockReturnValue({
      id: "dev_1", name: "mac", host: "10.0.0.2", port: 19384, auth: "password", password: "pw", addedAt: 1,
    } as never)

    const { res } = await drive("POST", "/dev_1/test")

    expect(JSON.parse(res._getData())).toMatchObject({ ok: false, reachable: false, code: "UNREACHABLE" })
    expect(mockedGetDeviceToken).not.toHaveBeenCalled()
  })

  it("reports unreachable when the token mint throws DeviceUnreachableError", async () => {
    const fetchFn = mockFetch()
    fetchFn.mockResolvedValueOnce(fakeResponse({ json: helloOk }))
    mockedGetDevice.mockReturnValue({
      id: "dev_1", name: "mac", host: "10.0.0.2", port: 19384, auth: "password", password: "pw", addedAt: 1,
    } as never)
    mockedGetDeviceToken.mockRejectedValue(new DeviceUnreachableError("down"))

    const { res } = await drive("POST", "/dev_1/test")

    expect(JSON.parse(res._getData())).toMatchObject({ ok: false, reachable: false, authState: "unknown" })
  })

  it("skips the token mint for auth:none tunnel devices", async () => {
    const fetchFn = mockFetch()
    fetchFn.mockResolvedValueOnce(fakeResponse({ json: helloOk }))
    mockedGetDevice.mockReturnValue({
      id: "dev_t", name: "mac", host: "127.0.0.1", port: 19384, auth: "none", addedAt: 1,
    } as never)

    const { res } = await drive("POST", "/dev_t/test")

    expect(JSON.parse(res._getData())).toMatchObject({ ok: true, authState: "ok" })
    expect(mockedGetDeviceToken).not.toHaveBeenCalled()
  })
})

// ── CSRF client-header guard ─────────────────────────────────────────────────

describe("X-Cogpit-Client CSRF guard", () => {
  it("rejects a mutation without the client header (403, never dispatches)", async () => {
    const fetchFn = mockFetch()

    const { res } = await drive("POST", "/probe", { host: "10.0.0.2" }, {})

    expect(res._getStatus()).toBe(403)
    expect(JSON.parse(res._getData()).code).toBe("MISSING_CLIENT_HEADER")
    // The guard runs before any handler, so nothing is probed or validated.
    expect(fetchFn).not.toHaveBeenCalled()
    expect(mockedValidateDeviceHost).not.toHaveBeenCalled()
  })

  it("rejects a PATCH without the client header (403)", async () => {
    const { res } = await drive("PATCH", "/dev_1", { name: "x" }, {})
    expect(res._getStatus()).toBe(403)
    expect(JSON.parse(res._getData()).code).toBe("MISSING_CLIENT_HEADER")
    expect(mockedGetDevice).not.toHaveBeenCalled()
  })

  it("rejects a DELETE without the client header (403)", async () => {
    const { res } = await drive("DELETE", "/dev_1", undefined, {})
    expect(res._getStatus()).toBe(403)
    expect(JSON.parse(res._getData()).code).toBe("MISSING_CLIENT_HEADER")
    expect(mockedRemoveDevice).not.toHaveBeenCalled()
  })

  it("allows a GET without the client header (read-only is not state-changing)", () => {
    mockedListDevices.mockReturnValue([] as never)
    const handler = getHandler()
    const { req, res, next } = createMockReqRes("GET", "/", undefined, {})
    handler(req as never, res as never, next)
    expect(res._getStatus()).toBe(200)
    expect(JSON.parse(res._getData())).toEqual({ devices: [] })
    expect(next).not.toHaveBeenCalled()
  })
})

// ── dispatch ────────────────────────────────────────────────────────────────

describe("route dispatch", () => {
  it("calls next for an unsupported method on an item", async () => {
    mockedGetDevice.mockReturnValue({
      id: "dev_1", name: "mac", host: "10.0.0.2", port: 19384, auth: "none", addedAt: 1,
    } as never)
    const handler = getHandler()
    const { req, res, next } = createMockReqRes("GET", "/dev_1")
    handler(req as never, res as never, next)
    expect(next).toHaveBeenCalled()
  })
})
