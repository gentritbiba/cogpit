// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Isolate the token lifecycle from the real registry: we only need to observe
// the authState side-effects it writes.
vi.mock("../../hub/registry", () => ({
  setDeviceRuntime: vi.fn(),
}))

import {
  getDeviceToken,
  invalidateDeviceToken,
  DeviceAuthError,
  DeviceUnreachableError,
} from "../../hub/device-client"
import { setDeviceRuntime, type HubDevice } from "../../hub/registry"

const mockSetRuntime = vi.mocked(setDeviceRuntime)

let mockFetch: ReturnType<typeof vi.fn>
let counter = 0

/** Each test gets a device with a unique id, so the module-level token/cooldown
 *  maps stay isolated without needing to reset modules. */
function makeDevice(overrides: Partial<HubDevice> = {}): HubDevice {
  counter += 1
  return {
    id: `dev_test_${counter}`,
    name: "Test Device",
    host: "10.0.0.5",
    port: 19384,
    auth: "password",
    password: "secretpassword",
    addedAt: 0,
    ...overrides,
  }
}

function okResponse(token: string): Response {
  return { ok: true, status: 200, json: async () => ({ valid: true, token }) } as unknown as Response
}

function statusResponse(status: number, body: unknown = { valid: false }): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch = vi.fn()
  vi.stubGlobal("fetch", mockFetch)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// ── auth: none ───────────────────────────────────────────────────────

describe("getDeviceToken — auth: none", () => {
  it("returns null and never hits the network", async () => {
    const device = makeDevice({ auth: "none", password: undefined })
    expect(await getDeviceToken(device)).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

// ── Single-flight ────────────────────────────────────────────────────

describe("getDeviceToken — single-flight", () => {
  it("collapses N concurrent callers into one network request", async () => {
    let resolveFetch!: (r: Response) => void
    mockFetch.mockReturnValue(new Promise<Response>((r) => { resolveFetch = r }))

    const device = makeDevice()
    const calls = [getDeviceToken(device), getDeviceToken(device), getDeviceToken(device)]

    // fetch is invoked synchronously by the first caller; the rest share it.
    expect(mockFetch).toHaveBeenCalledTimes(1)

    resolveFetch(okResponse("tok1"))
    const results = await Promise.all(calls)

    expect(results).toEqual(["tok1", "tok1", "tok1"])
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("posts to the device /api/auth/verify with a Bearer password", async () => {
    mockFetch.mockResolvedValue(okResponse("tok1"))
    const device = makeDevice({ host: "192.168.1.9", port: 20000, password: "hunter2secret" })

    await getDeviceToken(device)

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe("http://192.168.1.9:20000/api/auth/verify")
    expect((init as RequestInit).method).toBe("POST")
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer hunter2secret" })
  })

  it("mints over https for a tls device", async () => {
    mockFetch.mockResolvedValue(okResponse("tok1"))
    const device = makeDevice({ host: "cogpit.example.com", port: 443, tls: true })

    await getDeviceToken(device)

    expect(mockFetch.mock.calls[0][0]).toBe("https://cogpit.example.com:443/api/auth/verify")
  })
})

// ── Cache reuse ──────────────────────────────────────────────────────

describe("getDeviceToken — caching", () => {
  it("reuses a freshly minted token without re-minting", async () => {
    mockFetch.mockResolvedValue(okResponse("tok1"))
    const device = makeDevice()

    expect(await getDeviceToken(device)).toBe("tok1")
    expect(await getDeviceToken(device)).toBe("tok1")
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("re-mints after invalidateDeviceToken", async () => {
    mockFetch.mockResolvedValueOnce(okResponse("tok1")).mockResolvedValueOnce(okResponse("tok2"))
    const device = makeDevice()

    expect(await getDeviceToken(device)).toBe("tok1")
    invalidateDeviceToken(device.id)
    expect(await getDeviceToken(device)).toBe("tok2")
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})

// ── Cooldown ─────────────────────────────────────────────────────────

describe("getDeviceToken — cooldown after failure", () => {
  it("rethrows the last error without a network call inside the cooldown, then retries after it", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"))
    const device = makeDevice()

    await expect(getDeviceToken(device)).rejects.toBeInstanceOf(DeviceUnreachableError)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    // Within 5s of the failed attempt → no network, same error.
    vi.setSystemTime(1000)
    await expect(getDeviceToken(device)).rejects.toBeInstanceOf(DeviceUnreachableError)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    // Past the cooldown → the network is tried again.
    vi.setSystemTime(6000)
    await expect(getDeviceToken(device)).rejects.toBeInstanceOf(DeviceUnreachableError)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})

// ── Error taxonomy + runtime side-effects ────────────────────────────

describe("getDeviceToken — errors and authState", () => {
  it("maps a 401 to DeviceAuthError and marks the device bad-password", async () => {
    mockFetch.mockResolvedValue(statusResponse(401))
    const device = makeDevice()

    await expect(getDeviceToken(device)).rejects.toBeInstanceOf(DeviceAuthError)
    expect(mockSetRuntime).toHaveBeenCalledWith(device.id, expect.objectContaining({ authState: "bad-password" }))
  })

  it("maps a 200 without a token to DeviceAuthError", async () => {
    mockFetch.mockResolvedValue(statusResponse(200, { valid: true }))
    const device = makeDevice()
    await expect(getDeviceToken(device)).rejects.toBeInstanceOf(DeviceAuthError)
  })

  it("maps a network failure to DeviceUnreachableError and does not mark bad-password", async () => {
    mockFetch.mockRejectedValue(new Error("ETIMEDOUT"))
    const device = makeDevice()

    await expect(getDeviceToken(device)).rejects.toBeInstanceOf(DeviceUnreachableError)
    expect(mockSetRuntime).not.toHaveBeenCalledWith(device.id, expect.objectContaining({ authState: "bad-password" }))
  })

  it("marks the device ok on a successful mint", async () => {
    mockFetch.mockResolvedValue(okResponse("tok1"))
    const device = makeDevice()

    await getDeviceToken(device)
    expect(mockSetRuntime).toHaveBeenCalledWith(device.id, expect.objectContaining({ authState: "ok" }))
  })
})
