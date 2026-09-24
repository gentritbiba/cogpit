import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"

const mocks = vi.hoisted(() => ({
  activeDevice: undefined as { name: string } | undefined,
  remoteClient: false,
  manageDevices: true,
  authFetch: vi.fn(),
  useDevices: vi.fn(),
}))
vi.mock("@/hooks/useDevices", () => ({ useDevices: mocks.useDevices }))
vi.mock("@/hooks/useCapability", () => ({ useCapability: (name: string) => name === "manageDevices" && mocks.manageDevices }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch, isRemoteClient: () => mocks.remoteClient }))

import { useFolderHostName } from "@/hooks/useFolderHostName"

beforeEach(() => {
  mocks.activeDevice = undefined
  mocks.remoteClient = false
  mocks.manageDevices = true
  mocks.useDevices.mockReset().mockImplementation(({ enabled = true }: { enabled?: boolean } = {}) =>
    ({ activeDevice: enabled ? mocks.activeDevice : undefined }))
  mocks.authFetch.mockReset().mockResolvedValue(new Response(JSON.stringify({ app: "cogpit", name: "mini.local" })))
})

describe("useFolderHostName", () => {
  it("names nothing on the machine the user sits at", () => {
    expect(renderHook(() => useFolderHostName()).result.current).toBeNull()
    expect(mocks.authFetch).not.toHaveBeenCalled()
  })

  it("names the hub device by its name in the hub", () => {
    mocks.activeDevice = { name: "Mac mini" }
    mocks.remoteClient = true
    expect(renderHook(() => useFolderHostName()).result.current).toBe("Mac mini")
    expect(mocks.authFetch).not.toHaveBeenCalled()
  })

  it("names the server a remote browser is connected to, as it names itself", async () => {
    mocks.remoteClient = true
    const { result } = renderHook(() => useFolderHostName())
    await waitFor(() => expect(result.current).toBe("mini.local"))
    expect(mocks.authFetch).toHaveBeenCalledWith("/api/hello", expect.anything())
  })

  it("does not read the hub's devices for an account that may not manage them", () => {
    mocks.manageDevices = false
    renderHook(() => useFolderHostName())
    expect(mocks.useDevices).toHaveBeenCalledWith({ enabled: false })
  })
})
