import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ViewPublication } from "../../../../shared/views/publish"

const mocks = vi.hoisted(() => ({
  publication: undefined as ViewPublication | null | undefined,
  publishers: [] as unknown[],
  publish: vi.fn(),
  unpublish: vi.fn(),
  copy: vi.fn(async () => true),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))
vi.mock("@/components/timeline/cogpit-blocks/view/storedView", () => ({ usePublication: () => mocks.publication }))
vi.mock("../useViewPublishing", async (original) => ({
  ...await original<typeof import("../useViewPublishing")>(),
  useViewPublishing: () => ({
    publishers: mocks.publishers,
    publish: mocks.publish,
    unpublish: mocks.unpublish,
    publisherOf: (publication: ViewPublication | null | undefined) => (mocks.publishers as { id: string }[]).find((plugin) => plugin.id === publication?.pluginId) ?? null,
  }),
}))
vi.mock("@/lib/utils", async (original) => ({ ...await original<typeof import("@/lib/utils")>(), copyToClipboard: mocks.copy }))
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }))

import { PluginRequestError } from "@/plugins/runtimeClient"
import { PublishViewMenu } from "../PublishViewMenu"

const share = { id: "dev-me.share", manifest: { contributes: { publish: { title: "Share host" } } } }
const published: ViewPublication = { pluginId: "dev-me.share", title: "Share host", url: "https://share.example.com/abc/", version: 1, publishedAt: "2026-11-19T00:00:00.000Z" }

beforeEach(() => {
  mocks.publication = null
  mocks.publishers = [share]
  vi.clearAllMocks()
})
afterEach(cleanup)

const open = async () => userEvent.click(screen.getByTestId("view-publish"))

describe("PublishViewMenu", () => {
  it("is hidden when nothing publishes views and the view is not published", () => {
    mocks.publishers = []
    const { container } = render(<PublishViewMenu id="funnel" title="Funnel" version={2} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("publishes the shown version only after the user confirms, and copies the link", async () => {
    mocks.publish.mockResolvedValue(published)
    render(<PublishViewMenu id="funnel" title="Funnel" version={2} />)
    await open()
    await userEvent.click(await screen.findByRole("menuitem", { name: "Publish with Share host" }))
    expect(await screen.findByText(/Anyone with the link can open it/)).toBeInTheDocument()
    expect(mocks.publish).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Publish" }))
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledWith(share, "funnel", 2))
    expect(mocks.copy).toHaveBeenCalledWith(published.url)
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Published, link copied", { description: published.url })
  })

  it("shows the host's refusal in the dialog", async () => {
    mocks.publish.mockRejectedValue(new PluginRequestError("Connection operation failed", "UPSTREAM_FAILED", 400))
    render(<PublishViewMenu id="funnel" title="Funnel" version={2} />)
    await open()
    await userEvent.click(await screen.findByRole("menuitem", { name: "Publish with Share host" }))
    await userEvent.click(await screen.findByRole("button", { name: "Publish" }))
    expect(await screen.findByText("Share host refused the request. Check its connection in Plugins.")).toBeInTheDocument()
  })

  it("updates a published view to the shown version and takes it down after confirming", async () => {
    mocks.publication = published
    mocks.publish.mockResolvedValue({ ...published, version: 3 })
    render(<PublishViewMenu id="funnel" title="Funnel" version={3} />)
    expect(screen.getByTestId("view-publish")).toHaveAccessibleName("Published · v1")
    await open()
    await userEvent.click(await screen.findByRole("menuitem", { name: "Update to v3" }))
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledWith(share, "funnel", 3))

    await open()
    await userEvent.click(await screen.findByRole("menuitem", { name: "Take down" }))
    await userEvent.click(await screen.findByRole("button", { name: "Take down" }))
    await waitFor(() => expect(mocks.unpublish).toHaveBeenCalledWith(share, "funnel"))
  })

  it("only copies or opens a page whose host plugin is not installed here", async () => {
    mocks.publication = published
    mocks.publishers = []
    render(<PublishViewMenu id="funnel" title="Funnel" version={3} />)
    await open()
    expect(await screen.findByText(/Share host is not installed/)).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: /Update|Take down/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("menuitem", { name: "Copy link" }))
    expect(mocks.copy).toHaveBeenCalledWith(published.url)
  })
})
