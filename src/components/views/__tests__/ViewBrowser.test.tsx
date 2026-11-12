import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ViewSummary } from "../../../../shared/views/stored"

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  toastError: vi.fn(),
}))
vi.mock("@/lib/auth", () => ({
  authFetch: mocks.authFetch,
  authUrl: (path: string) => path,
  jsonFetch: (input: string, body: unknown, init: RequestInit = {}) => mocks.authFetch(input, { method: "POST", ...init, body: JSON.stringify(body) }),
}))
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }))

import { ViewBrowser } from "../ViewBrowser"
import { ViewPanelProvider, useViewPanel } from "../ViewPanelContext"

const HOUR = 3_600_000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

function summary(overrides: Partial<ViewSummary> & Pick<ViewSummary, "id" | "title">): ViewSummary {
  return { project: "/Users/me/code/shop", latestVersion: 1, updatedAt: ago(HOUR), pinned: false, ...overrides }
}

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))

/** Answers the views API from `views`, applying PATCH and DELETE to it. */
function serve(initial: ViewSummary[]) {
  let views = [...initial]
  mocks.authFetch.mockImplementation((url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    if (url === "/api/views" && method === "GET") return json({ views })
    const id = decodeURIComponent(url.split("/").pop() ?? "")
    if (method === "PATCH") {
      const change = JSON.parse(String(init.body)) as Partial<ViewSummary>
      if (change.title === "") return json({ error: "A view's title is 1 to 200 characters" }, 400)
      views = views.map((view) => (view.id === id ? { ...view, ...change } : view))
      return json(views.find((view) => view.id === id))
    }
    if (method === "DELETE") {
      views = views.filter((view) => view.id !== id)
      return json({ deleted: true })
    }
    return json({ error: "unexpected" }, 500)
  })
}

function PanelTarget() {
  const panel = useViewPanel()
  return <output data-testid="panel-target">{panel?.target ? `${panel.target.id}@${panel.target.version}` : "none"}</output>
}

function renderBrowser(onReveal = vi.fn()) {
  render(
    <ViewPanelProvider shown={false} onReveal={onReveal}>
      <ViewBrowser />
      <PanelTarget />
    </ViewPanelProvider>,
  )
  return onReveal
}

const titles = () => screen.getAllByRole("button", { name: /v\d+|Not built yet/ })
  .map((row) => row.closest("[data-view-row]")!.getAttribute("data-view-row"))

/** The button that opens a listed view. */
const rowOf = async (title: string) => (await screen.findByText(title)).closest("button")!

async function chooseAction(title: string, action: string) {
  await userEvent.click(screen.getByRole("button", { name: `Actions for ${title}` }))
  await userEvent.click(await screen.findByRole("menuitem", { name: action }))
}

beforeEach(() => {
  mocks.authFetch.mockReset()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("ViewBrowser", () => {
  it("lists pinned views first, then the newest, on date shelves", async () => {
    serve([
      summary({ id: "fresh", title: "Fresh chart", updatedAt: ago(HOUR) }),
      summary({ id: "old", title: "Old map", updatedAt: ago(40 * 24 * HOUR) }),
      summary({ id: "kept", title: "Kept funnel", updatedAt: ago(10 * 24 * HOUR), pinned: true }),
    ])
    renderBrowser()

    await screen.findByText("Fresh chart")
    expect(titles()).toEqual(["kept", "fresh", "old"])
    expect(screen.getByText("Pinned")).toBeInTheDocument()
    expect(screen.getByText("Older")).toBeInTheDocument()
    expect(within(screen.getByText("Kept funnel").closest("button")!).getByRole("img", { name: "Pinned" })).toBeInTheDocument()
  })

  it("names each view's project", async () => {
    serve([
      summary({ id: "shop-view", title: "Shop view", project: "/Users/me/code/shop", updatedAt: ago(HOUR) }),
      summary({ id: "blog-view", title: "Blog view", project: "/Users/me/code/blog", updatedAt: ago(2 * HOUR) }),
    ])
    renderBrowser()
    await screen.findByText("Blog view")
    const projects = [...document.querySelectorAll("[data-view-project]")].map((node) => node.textContent)
    expect(projects).toEqual(["code/shop", "code/blog"])
  })

  it("explains an empty list", async () => {
    serve([])
    renderBrowser()
    expect(await screen.findByText("No views yet")).toBeInTheDocument()
    expect(screen.getByText(/When an agent builds an interactive view/)).toBeInTheDocument()
  })

  it("opens a view's newest version in the panel", async () => {
    serve([summary({ id: "sales-funnel", title: "Sales funnel", latestVersion: 4 }), summary({ id: "draft", title: "Draft", latestVersion: null })])
    const reveal = renderBrowser()

    await userEvent.click(await rowOf("Sales funnel"))
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("panel-target")).toHaveTextContent("sales-funnel@4")
    expect(await rowOf("Draft")).toBeDisabled()
    expect(await rowOf("Draft")).toHaveTextContent("Not built yet")
  })

  it("pins a view through PATCH and moves it to the top", async () => {
    serve([
      summary({ id: "first", title: "First", updatedAt: ago(HOUR) }),
      summary({ id: "second", title: "Second", updatedAt: ago(2 * HOUR) }),
    ])
    renderBrowser()
    await screen.findByText("Second")

    await chooseAction("Second", "Pin view")

    await waitFor(() => expect(titles()).toEqual(["second", "first"]))
    expect(mocks.authFetch).toHaveBeenCalledWith("/api/views/second", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ pinned: true }) }))
  })

  it("renames a view through PATCH and shows the server's refusal", async () => {
    serve([summary({ id: "sales-funnel", title: "Sales funnel" })])
    renderBrowser()
    await screen.findByText("Sales funnel")

    await chooseAction("Sales funnel", "Rename view")
    const input = await screen.findByLabelText("View name")
    await userEvent.clear(input)
    await userEvent.type(input, "Q3 funnel")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(await screen.findByText("Q3 funnel")).toBeInTheDocument()
    expect(mocks.authFetch).toHaveBeenCalledWith("/api/views/sales-funnel", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ title: "Q3 funnel" }) }))
    expect(screen.queryByLabelText("View name")).not.toBeInTheDocument()
  })

  it("deletes a view only after confirming, and clears it from the panel", async () => {
    serve([summary({ id: "sales-funnel", title: "Sales funnel", latestVersion: 2 }), summary({ id: "other", title: "Other" })])
    renderBrowser()
    await userEvent.click(await rowOf("Sales funnel"))
    expect(screen.getByTestId("panel-target")).toHaveTextContent("sales-funnel@2")

    await chooseAction("Sales funnel", "Delete view")
    expect(mocks.authFetch).not.toHaveBeenCalledWith("/api/views/sales-funnel", expect.objectContaining({ method: "DELETE" }))
    await userEvent.click(await screen.findByRole("button", { name: "Delete view" }))

    await waitFor(() => expect(screen.queryByText("Sales funnel")).not.toBeInTheDocument())
    expect(mocks.authFetch).toHaveBeenCalledWith("/api/views/sales-funnel", expect.objectContaining({ method: "DELETE" }))
    expect(screen.getByText("Other")).toBeInTheDocument()
    expect(screen.getByTestId("panel-target")).toHaveTextContent("none")
  })

  it("offers a retry when the list cannot load", async () => {
    mocks.authFetch.mockImplementation(() => json({ error: "Views are unavailable" }, 500))
    renderBrowser()
    expect(await screen.findByText("Views are unavailable")).toBeInTheDocument()

    serve([summary({ id: "sales-funnel", title: "Sales funnel" })])
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(await screen.findByText("Sales funnel")).toBeInTheDocument()
  })
})
