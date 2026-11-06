import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ device: "local", authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))
vi.mock("@/lib/device", () => ({ getActiveDeviceScope: () => mocks.device }))

import { rememberNewestVersions, useNewestVersion, viewsScope } from "../view/storedView"

function Newest({ id }: { id: string }) {
  return <p data-testid="newest">{useNewestVersion(id) ?? "none"}</p>
}

afterEach(() => {
  cleanup()
  mocks.device = "local"
})

describe("newest versions", () => {
  it("files a late answer under the device its request went to", async () => {
    let answer!: () => void
    mocks.authFetch.mockImplementation(() => new Promise<Response>((done) => {
      answer = () => done(new Response(JSON.stringify({ views: [{ id: "shared-id", title: "", project: "/p", latestVersion: 9, updatedAt: "", pinned: false }] })))
    }))
    mocks.device = "device-a"
    const { rerender } = render(<Newest id="shared-id" />)
    act(() => { window.dispatchEvent(new Event("focus")) })
    expect(mocks.authFetch).toHaveBeenCalledWith("/api/views")

    // The user switches to device B, where the same id is at v1, before A answers.
    mocks.device = "device-b"
    act(() => { rememberNewestVersions(viewsScope(), [{ id: "shared-id", latestVersion: 1 }]) })
    rerender(<Newest id="shared-id" />)
    expect(screen.getByTestId("newest")).toHaveTextContent("1")

    await act(async () => { answer() })
    rerender(<Newest id="shared-id" />)
    expect(screen.getByTestId("newest")).toHaveTextContent("1")

    mocks.device = "device-a"
    rerender(<Newest id="shared-id" />)
    expect(screen.getByTestId("newest")).toHaveTextContent("9")

    // Device A moves to a new address: what its old connection said no longer counts.
    mocks.device = "device-a@2"
    act(() => { rememberNewestVersions(viewsScope(), [{ id: "shared-id", latestVersion: 1 }]) })
    rerender(<Newest id="shared-id" />)
    expect(screen.getByTestId("newest")).toHaveTextContent("1")
  })

  it("never lowers what it knows", () => {
    rememberNewestVersions(viewsScope(), [{ id: "steady", latestVersion: 4 }, { id: "unbuilt", latestVersion: null }])
    rememberNewestVersions(viewsScope(), [{ id: "steady", latestVersion: 2 }])
    render(<><Newest id="steady" /><Newest id="unbuilt" /></>)
    expect(screen.getAllByTestId("newest").map((node) => node.textContent)).toEqual(["4", "none"])
  })
})
