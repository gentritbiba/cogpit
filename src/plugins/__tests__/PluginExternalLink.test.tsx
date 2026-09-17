import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { usePluginExternalLink } from "../PluginExternalLink"

let openExternal: ReturnType<typeof usePluginExternalLink>["openExternal"]
function Fixture() {
  const value = usePluginExternalLink("ClickUp")
  openExternal = value.openExternal
  return value.dialog
}
afterEach(() => vi.restoreAllMocks())

describe("plugin external links", () => {
  it("shows the exact destination and opens only after a trusted click", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    render(<Fixture />)
    let request!: Promise<void>
    act(() => { request = openExternal("https://app.clickup.com/t/task-1", new AbortController().signal) })
    expect(screen.getByRole("dialog")).toHaveTextContent("https://app.clickup.com/t/task-1")
    expect(open).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Open website" }))
    await expect(request).resolves.toBeUndefined()
    expect(open).toHaveBeenCalledExactlyOnceWith("https://app.clickup.com/t/task-1", "_blank", "noopener,noreferrer")
  })
  it("cancels the pending link on activation revocation", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    render(<Fixture />)
    const controller = new AbortController()
    let request!: Promise<void>
    act(() => { request = openExternal("https://example.com/task", controller.signal) })
    const rejected = expect(request).rejects.toMatchObject({ code: "CANCELED" })
    act(() => controller.abort())
    await rejected
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(open).not.toHaveBeenCalled()
  })
  it("rejects parallel requests, privileged schemes and credentials", async () => {
    const view = render(<Fixture />)
    for (const url of ["http://example.com", "file:///tmp/test", "javascript:alert(1)", "https://user:secret@example.com"]) {
      await expect(openExternal(url, new AbortController().signal)).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    }
    let request!: Promise<void>
    act(() => { request = openExternal("https://example.com/task", new AbortController().signal) })
    await expect(openExternal("https://other.example.com", new AbortController().signal)).rejects.toMatchObject({ code: "RATE_LIMITED" })
    const rejected = expect(request).rejects.toMatchObject({ code: "CANCELED" })
    view.unmount()
    await rejected
  })
})
