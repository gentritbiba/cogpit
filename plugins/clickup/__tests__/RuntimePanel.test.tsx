import type { JsonValue } from "@cogpit/plugin-sdk"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RuntimePanel } from "../RuntimePanel"
import { createClickUpRuntimeStore, type ClickUpRuntimeStore } from "../runtimeStore"
import { connectionStatus, fakeClient, list, rawTask, runtimeContext, viewer } from "./runtimeFixtures"
const stores: ClickUpRuntimeStore[] = []
afterEach(() => { cleanup(); for (const store of stores.splice(0)) store.dispose() })
function panel(client = fakeClient(), context = runtimeContext) {
  const store = createClickUpRuntimeStore(client)
  stores.push(store)
  return { client, store, ...render(<RuntimePanel client={client} context={context} store={store} />) }
}
describe("independent ClickUp panel", () => {
  it("directs setup to the parent without token or project link collectors", async () => {
    const client = fakeClient()
    vi.mocked(client.connections.status).mockResolvedValue({ configured: false, readOnly: false, selected: {} })
    panel(client)
    expect(await screen.findByRole("heading", { name: "Connect ClickUp" })).toBeInTheDocument()
    expect(screen.getByText(/Use Connections above/)).toBeInTheDocument()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(document.querySelector('input[type="password"]')).toBeNull()
    expect(client.connections.request).not.toHaveBeenCalled()
  })
  it("preserves task ordering, custom IDs, search and due/priority filters", async () => {
    const client = fakeClient()
    vi.mocked(client.connections.request).mockImplementation(async (_h, op): Promise<JsonValue> => op === "viewer" ? { user: viewer } : { tasks: [rawTask("2", { name: "Next release" }), rawTask("1", { name: "Fix inventory", due_date: String(Date.now() - 172800000), priority: { priority: "high" } })], last_page: true })
    panel(client)
    await screen.findByRole("article", { name: "Fix inventory" })
    expect(screen.getAllByRole("article").map((value) => value.getAttribute("aria-label"))).toEqual(["Fix inventory", "Next release"])
    expect(screen.getByText("APP-1")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: /^Overdue/ }))
    expect(screen.getAllByRole("article")).toHaveLength(1)
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }))
    await userEvent.type(screen.getByRole("searchbox"), "APP-2")
    expect(screen.getAllByRole("article").map((value) => value.getAttribute("aria-label"))).toEqual(["Next release"])
  })
  it("sends drafts and every task/workspace/description link through the SDK", async () => {
    const client = fakeClient(), description = "[Reference](https://example.com/reference)\n\n![diagram](https://example.com/image.png)"
    vi.mocked(client.connections.request).mockImplementation(async (_h, op): Promise<JsonValue> => op === "viewer" ? { user: viewer } : { tasks: [rawTask("1", { markdown_description: description })], last_page: true })
    panel(client)
    await screen.findByRole("article", { name: "Task 1" })
    await userEvent.click(screen.getByRole("button", { name: "Example workspace · Alex" }))
    expect(client.navigation.openExternal).toHaveBeenLastCalledWith("https://app.clickup.com/10/home")
    await userEvent.click(screen.getByRole("button", { name: "Task 1: to do" }))
    await userEvent.click(screen.getByRole("button", { name: "Reference" }))
    expect(client.navigation.openExternal).toHaveBeenLastCalledWith("https://example.com/reference")
    await userEvent.click(screen.getByRole("button", { name: "Open in ClickUp" }))
    expect(client.navigation.openExternal).toHaveBeenLastCalledWith("https://app.clickup.com/t/1")
    await userEvent.click(screen.getByRole("button", { name: "Add to prompt" }))
    expect(client.composer.append).toHaveBeenCalledWith(`Work on ClickUp task APP-1: Task 1\nhttps://app.clickup.com/t/1\n\n${description}`)
    expect(document.querySelectorAll("a[href], img, iframe")).toHaveLength(0)
    expect(screen.getByText("[Image: diagram]")).toBeInTheDocument()
  })
  it("treats a canceled external link confirmation as a normal user action", async () => {
    const client = fakeClient()
    vi.mocked(client.navigation.openExternal).mockRejectedValue({ code: "CANCELED" })
    panel(client)
    await screen.findByRole("article", { name: "Task 1" })
    await userEvent.click(screen.getByRole("button", { name: "Open APP-1 in ClickUp" }))
    expect(client.navigation.openExternal).toHaveBeenCalledWith("https://app.clickup.com/t/1")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByRole("article", { name: "Task 1" })).toBeInTheDocument()
  })
  it("reports draft permission failures without losing the task", async () => {
    const client = fakeClient()
    vi.mocked(client.composer.append).mockRejectedValue(new Error("private host detail"))
    panel(client)
    await screen.findByRole("article", { name: "Task 1" })
    await userEvent.click(screen.getByRole("button", { name: "Task 1: to do" }))
    await userEvent.click(screen.getByRole("button", { name: "Add to prompt" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to add this task to your draft")
    expect(screen.getByRole("article", { name: "Task 1" })).toBeInTheDocument()
  })
  it("preserves project closed folding and routes list links through navigation", async () => {
    const client = fakeClient()
    vi.mocked(client.connections.request).mockImplementation(async (_h, op, args): Promise<JsonValue> => {
      if (op === "viewer") return { user: viewer }
      if (op === "list") return list
      return { tasks: [rawTask(args.closed ? "closed" : "open", args.closed ? { status: { status: "complete", type: "closed" } } : {})], last_page: true }
    })
    panel(client)
    await screen.findByRole("article", { name: "Task open" })
    await userEvent.click(screen.getByRole("tab", { name: /This project/ }))
    const listLink = await screen.findByRole("button", { name: "Product › Sprint" })
    await userEvent.click(listLink)
    expect(client.navigation.openExternal).toHaveBeenLastCalledWith("https://app.clickup.com/v/li/30")
    const project = screen.getAllByRole("tabpanel").find((value) => !value.hasAttribute("inert"))!
    expect(within(project).queryByRole("article", { name: "Task closed" })).not.toBeInTheDocument()
    await userEvent.click(within(project).getByRole("button", { name: /Closed/ }))
    expect(within(project).getByRole("article", { name: "Task closed" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Unlink/ })).not.toBeInTheDocument()
  })
  it("keeps My tasks available without a project and disables project scope", async () => {
    panel(fakeClient(), { ...runtimeContext, project: null })
    await screen.findByRole("article", { name: "Task 1" })
    expect(screen.getByRole("tab", { name: /This project/ })).toHaveAttribute("aria-disabled", "true")
    await userEvent.click(screen.getByRole("tab", { name: /This project/ }))
    expect(screen.getByRole("tab", { name: /My tasks/ })).toHaveAttribute("aria-selected", "true")
  })
  it("instructs project selection in parent settings and keeps stale results when refresh fails", async () => {
    const client = fakeClient()
    vi.mocked(client.connections.status).mockResolvedValue({ ...connectionStatus, selected: { workspace: connectionStatus.selected.workspace } })
    const { store } = panel(client)
    await screen.findByRole("article", { name: "Task 1" })
    await userEvent.click(screen.getByRole("tab", { name: /This project/ }))
    expect(await screen.findByRole("heading", { name: "Link this project to a ClickUp list" })).toBeInTheDocument()
    expect(screen.queryByRole("textbox", { name: /URL/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("tab", { name: /My tasks/ }))
    vi.mocked(client.connections.request).mockRejectedValue(new Error("unavailable"))
    await act(async () => { await store.mine.load(true) })
    expect(screen.getByRole("status")).toHaveTextContent("Showing previously loaded tasks")
    expect(screen.getByRole("article", { name: "Task 1" })).toBeInTheDocument()
  })
})
