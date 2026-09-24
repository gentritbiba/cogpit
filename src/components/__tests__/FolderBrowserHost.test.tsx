import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { FolderBrowserHost } from "@/components/FolderBrowserHost"
import { openFolderBrowser } from "@/lib/folders"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith("/api/folders")
    ? { path: "/home/me", parent: "/home", root: "/home/me", folders: [], truncated: false }
    : []))),
  jsonFetch: vi.fn(),
}))
vi.mock("@/hooks/useProjectNames", () => ({ useProjectNames: () => ({ names: {} }) }))
vi.mock("@/hooks/useFolderHostName", () => ({ useFolderHostName: () => "Mac mini" }))

// The host loads the switcher lazily; loading it first keeps a busy machine inside the waits below.
beforeAll(async () => {
  await import("@/components/ProjectSwitcherModal")
})

afterEach(cleanup)

describe("FolderBrowserHost", () => {
  it("opens the switcher on the folder browser when asked, and starts where the user chose", async () => {
    const user = userEvent.setup()
    const onNewFolder = vi.fn()
    render(<FolderBrowserHost onNewSession={vi.fn()} onNewFolder={onNewFolder} defaultAgentKind="claude" />)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()

    act(() => openFolderBrowser())

    expect(await screen.findByText("Folders on Mac mini", undefined, { timeout: 5_000 })).toBeInTheDocument()
    await screen.findByText("No folders here", undefined, { timeout: 5_000 })
    await user.click(screen.getByRole("button", { name: "Start session here" }))

    expect(onNewFolder).toHaveBeenCalledWith("/home/me")
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })
})
