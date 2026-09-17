import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockAuthFetch, mockIsRemoteDeviceActive } = vi.hoisted(() => ({
  mockAuthFetch: vi.fn(),
  mockIsRemoteDeviceActive: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ authFetch: mockAuthFetch }))
vi.mock("@/lib/device", () => ({ isRemoteDeviceActive: mockIsRemoteDeviceActive }))

const { openProjectTerminal } = await import("@/lib/openTerminal")

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse(String((call[1] as RequestInit).body))
}

describe("openProjectTerminal", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAuthFetch.mockResolvedValue({ ok: true, json: async () => ({}) })
    mockIsRemoteDeviceActive.mockReturnValue(false)
  })

  it("posts the project location to the terminal route", () => {
    expect(openProjectTerminal({ path: "/work/app", dirName: "-work-app" })).toBe(true)

    const [url, init] = mockAuthFetch.mock.calls[0]
    expect(url).toBe("/api/open-terminal")
    expect(init.method).toBe("POST")
    expect(bodyOf(mockAuthFetch.mock.calls[0])).toEqual({ path: "/work/app", dirName: "-work-app" })
  })

  it("passes a command through when one is given", () => {
    openProjectTerminal({ path: "/work/app", command: "agent --resume abc-123" })
    expect(bodyOf(mockAuthFetch.mock.calls[0]).command).toBe("agent --resume abc-123")
  })

  it("omits the command key entirely when none is given", () => {
    openProjectTerminal({ path: "/work/app" })
    expect(bodyOf(mockAuthFetch.mock.calls[0])).not.toHaveProperty("command")
  })

  /**
   * A native terminal window opens on the machine running the server. Asking a
   * remote device for one would open it somewhere the user cannot see.
   */
  it("refuses while a remote device is active", () => {
    mockIsRemoteDeviceActive.mockReturnValue(true)
    expect(openProjectTerminal({ path: "/work/app" })).toBe(false)
    expect(mockAuthFetch).not.toHaveBeenCalled()
  })

  it("refuses when it has neither a path nor a project directory", () => {
    expect(openProjectTerminal({})).toBe(false)
    expect(mockAuthFetch).not.toHaveBeenCalled()
  })

  it("does not reject when the request fails", async () => {
    mockAuthFetch.mockRejectedValue(new Error("offline"))
    expect(() => openProjectTerminal({ path: "/work/app" })).not.toThrow()
    await Promise.resolve()
  })
})
