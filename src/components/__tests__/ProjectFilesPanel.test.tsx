import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ProjectFilesPanel } from "@/components/ProjectFilesPanel"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))

function jsonResponse(data: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => data }
}

describe("ProjectFilesPanel", () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.authFetch.mockReset()
    mocks.authFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/git-status")) {
        return Promise.resolve(jsonResponse({
          isRepository: true,
          branch: "main",
          upstream: "origin/main",
          ahead: 1,
          behind: 0,
          files: [{ path: "src/App.tsx", indexStatus: " ", workTreeStatus: "M" }],
        }))
      }
      if (url.startsWith("/api/project-files")) {
        return Promise.resolve(jsonResponse({ files: ["src/App.tsx", "README.md"], truncated: false }))
      }
      if (url.startsWith("/api/project-file?") && !init?.method) {
        return Promise.resolve(jsonResponse({ content: "const value = 1\n", mtimeMs: 10, size: 16 }))
      }
      if (url === "/api/project-file" && init?.method === "PUT") {
        return Promise.resolve(jsonResponse({ ok: true, mtimeMs: 20, size: 16 }))
      }
      throw new Error(`Unexpected request: ${url}`)
    })
  })

  it("searches, opens, edits, and saves project files", async () => {
    const user = userEvent.setup()
    render(<ProjectFilesPanel cwd="/workspace/cogpit" onClose={vi.fn()} />)

    expect(await screen.findByText("main")).toBeInTheDocument()
    expect(screen.getByText("↑ 1")).toBeInTheDocument()
    await user.type(screen.getByRole("textbox", { name: "Search project files" }), "app")
    await user.click(await screen.findByRole("button", { name: /App\.tsx/ }))

    const editor = await screen.findByRole("textbox", { name: "Editing src/App.tsx" })
    fireEvent.change(editor, { target: { value: "const value = 2\n" } })
    expect(screen.getByText("Unsaved")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument())
    const saveCall = mocks.authFetch.mock.calls.find((call) => call[0] === "/api/project-file")
    expect(JSON.parse(saveCall?.[1]?.body as string)).toEqual({
      cwd: "/workspace/cogpit",
      path: "src/App.tsx",
      content: "const value = 2\n",
      expectedMtimeMs: 10,
    })
  })

  it("keeps conflict errors visible without marking the edit saved", async () => {
    const user = userEvent.setup()
    mocks.authFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/git-status")) return Promise.resolve(jsonResponse({ isRepository: false, files: [] }))
      if (url.startsWith("/api/project-files")) return Promise.resolve(jsonResponse({ files: ["src/App.tsx"] }))
      if (url.startsWith("/api/project-file?") && !init?.method) {
        return Promise.resolve(jsonResponse({ content: "one", mtimeMs: 10, size: 3 }))
      }
      return Promise.resolve(jsonResponse({ error: "File changed on disk. Reload it before saving." }, false, 409))
    })
    render(<ProjectFilesPanel cwd="/workspace/cogpit" onClose={vi.fn()} />)

    await user.click(await screen.findByRole("button", { name: /App\.tsx/ }))
    fireEvent.change(await screen.findByRole("textbox", { name: "Editing src/App.tsx" }), { target: { value: "two" } })
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("File changed on disk")
    expect(screen.getByText("Unsaved")).toBeInTheDocument()
  })

  it("filters the browser to whole-worktree changes", async () => {
    const user = userEvent.setup()
    render(<ProjectFilesPanel cwd="/workspace/cogpit" onClose={vi.fn()} />)

    await user.click(await screen.findByRole("button", { name: "Changes" }))

    expect(screen.getByRole("button", { name: /App\.tsx/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /README\.md/ })).not.toBeInTheDocument()
    expect(screen.getByText("M")).toBeInTheDocument()
  })

  it("sends selected file lines back to the composer context", async () => {
    const user = userEvent.setup()
    const onAddToPrompt = vi.fn()
    render(<ProjectFilesPanel cwd="/workspace/cogpit" onClose={vi.fn()} onAddToPrompt={onAddToPrompt} />)

    await user.click(await screen.findByRole("button", { name: /App\.tsx/ }))
    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Editing src/App.tsx" })
    editor.setSelectionRange(0, 11)
    fireEvent.select(editor)
    await user.click(screen.getByRole("button", { name: "Add selected lines to prompt" }))
    await user.type(screen.getByRole("textbox", { name: "Review comment" }), "Use a clearer name")
    await user.click(screen.getByRole("button", { name: "Add to prompt" }))

    expect(onAddToPrompt).toHaveBeenCalledWith({
      path: "src/App.tsx",
      text: "const value",
      startLine: 1,
      endLine: 1,
      comment: "Use a clearer name",
    })
  })
})
