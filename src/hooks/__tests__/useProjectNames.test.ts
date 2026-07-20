import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useProjectNames, renameProject } from "@/hooks/useProjectNames"

function setPath(pathname: string) {
  Object.defineProperty(window, "location", {
    value: { pathname },
    writable: true,
    configurable: true,
  })
}

describe("useProjectNames device scoping", () => {
  beforeEach(() => {
    localStorage.clear()
    setPath("/")
    // Reset the module-level snapshot to the (now empty) local scope.
    window.dispatchEvent(new Event("cogpit-device-changed"))
  })

  it("returns the local device's names on the bare key", () => {
    act(() => renameProject("-dir-a", "Local A"))
    expect(localStorage.getItem("project-custom-names")).toBe(
      JSON.stringify({ "-dir-a": "Local A" }),
    )

    const { result } = renderHook(() => useProjectNames())
    expect(result.current.names).toEqual({ "-dir-a": "Local A" })
  })

  it("does not see the local device's names on a fresh remote device", () => {
    act(() => renameProject("-dir-a", "Local A"))

    const { result } = renderHook(() => useProjectNames())
    expect(result.current.names).toEqual({ "-dir-a": "Local A" })

    // Switch to a remote device — the module snapshot reloads on the event.
    setPath("/d/dev_x/")
    act(() => window.dispatchEvent(new Event("cogpit-device-changed")))

    // The remote scope is empty; local names are invisible.
    expect(result.current.names).toEqual({})
  })

  it("keeps each device's names isolated across switches", () => {
    // Rename on the local device.
    act(() => renameProject("-dir-a", "Local A"))

    const { result } = renderHook(() => useProjectNames())

    // Switch to the remote device and rename the SAME dirName differently.
    setPath("/d/dev_x/")
    act(() => window.dispatchEvent(new Event("cogpit-device-changed")))
    expect(result.current.names).toEqual({})

    act(() => renameProject("-dir-a", "Remote A"))
    expect(result.current.names).toEqual({ "-dir-a": "Remote A" })

    // The remote write lands under the scoped key; the local key is untouched —
    // the lazy key alone is insufficient without the reload, so this proves the
    // in-memory snapshot did not merge the local names into the remote storage.
    expect(localStorage.getItem("project-custom-names::dev_x")).toBe(
      JSON.stringify({ "-dir-a": "Remote A" }),
    )
    expect(localStorage.getItem("project-custom-names")).toBe(
      JSON.stringify({ "-dir-a": "Local A" }),
    )

    // Switch back to local — its names are restored, the remote's are gone.
    setPath("/")
    act(() => window.dispatchEvent(new Event("cogpit-device-changed")))
    expect(result.current.names).toEqual({ "-dir-a": "Local A" })
  })
})
