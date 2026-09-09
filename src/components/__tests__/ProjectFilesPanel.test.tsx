import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ProjectFilesPanel } from "@/components/ProjectFilesPanel"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch, authUrl: (path: string) => path }))

function jsonResponse(data: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => data }
}

/** Mirror of the server's directory listing so tree requests see the same files as search. */
function treeResponse(files: string[], url: string) {
  const directory = new URL(url, "http://localhost").searchParams.get("dir") ?? ""
  const prefix = directory ? `${directory}/` : ""
  const names = new Map<string, "file" | "directory">()
  for (const file of files) {
    if (!file.startsWith(prefix)) continue
    const rest = file.slice(prefix.length)
    const slash = rest.indexOf("/")
    if (slash === -1) names.set(rest, "file")
    else names.set(rest.slice(0, slash), "directory")
  }
  const entries = [...names].map(([name, type]) => ({ name, type }))
  return jsonResponse({ entries, scanLimited: false })
}

const PROJECT_FILES = ["src/App.tsx", "README.md"]

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
      if (url.startsWith("/api/project-files/tree")) return Promise.resolve(treeResponse(PROJECT_FILES, url))
      if (url.startsWith("/api/project-files")) {
        return Promise.resolve(jsonResponse({ files: PROJECT_FILES, totalMatches: 2, scanLimited: false }))
      }
      if (url.startsWith("/api/project-file?") && !init?.method) {
        const content = url.includes("README") ? "# Cogpit\n\nSome *docs*.\n" : "const value = 1\n"
        return Promise.resolve(jsonResponse({ content, mtimeMs: 10, size: content.length }))
      }
      if (url.startsWith("/api/git-diff")) {
        return Promise.resolve(jsonResponse({
          path: "src/App.tsx",
          original: "const value = 1\n",
          current: "const value = 2\n",
          binary: false,
          tooLarge: false,
        }))
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
      if (url.startsWith("/api/project-files/tree")) return Promise.resolve(treeResponse(["src/App.tsx"], url))
      if (url.startsWith("/api/project-file?") && !init?.method) {
        return Promise.resolve(jsonResponse({ content: "one", mtimeMs: 10, size: 3 }))
      }
      return Promise.resolve(jsonResponse({ error: "File changed on disk. Reload it before saving." }, false, 409))
    })
    render(<ProjectFilesPanel cwd="/workspace/cogpit" onClose={vi.fn()} />)

    await user.click(await screen.findByRole("button", { name: "src" }))
    await user.click(await screen.findByRole("button", { name: /App\.tsx/ }))
    fireEvent.change(await screen.findByRole("textbox", { name: "Editing src/App.tsx" }), { target: { value: "two" } })
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("File changed on disk")
    expect(screen.getByText("Unsaved")).toBeInTheDocument()
  })

  it("asks before discarding edits to switch files or close the workspace", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<ProjectFilesPanel cwd="/workspace/cogpit" onClose={onClose} />)

    await user.click(await screen.findByRole("button", { name: "src" }))
    await user.click(await screen.findByRole("button", { name: /App\.tsx/ }))
    fireEvent.change(await screen.findByRole("textbox", { name: "Editing src/App.tsx" }), {
      target: { value: "const value = 2\n" },
    })

    await user.click(screen.getByRole("button", { name: /README\.md/ }))
    expect(await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" })).toBeInTheDocument()
    expect(screen.getByLabelText("Editing src/App.tsx")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Keep editing" }))

    await user.click(screen.getByRole("button", { name: /README\.md/ }))
    await user.click(await screen.findByRole("button", { name: "Discard changes" }))
    await screen.findByLabelText("Preview of README.md")
    await user.click(screen.getByRole("button", { name: "Edit" }))
    const readmeEditor = await screen.findByRole("textbox", { name: "Editing README.md" })
    fireEvent.change(readmeEditor, { target: { value: "changed readme" } })

    await user.click(screen.getByRole("button", { name: "Close project files" }))
    expect(await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Discard changes" }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("filters the browser to whole-worktree changes", async () => {
    const user = userEvent.setup()
    render(<ProjectFilesPanel cwd="/workspace/cogpit" onClose={vi.fn()} />)

    await user.click(await screen.findByRole("button", { name: "Changes" }))

    expect(screen.getByRole("button", { name: /App\.tsx/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /README\.md/ })).not.toBeInTheDocument()
    expect(screen.getByText("M")).toHaveAttribute("title", "Modified")
  })

  it("diffs a changed file against the last commit", async () => {
    const user = userEvent.setup()
    render(<ProjectFilesPanel cwd="/workspace/cogpit" onClose={vi.fn()} />)

    await user.click(await screen.findByRole("button", { name: "Changes" }))
    await user.click(await screen.findByRole("button", { name: /App\.tsx/ }))

    expect(await screen.findByText("const value = 1")).toBeInTheDocument()
    expect(screen.getByText("const value = 2")).toBeInTheDocument()
    expect(screen.getByText("+1")).toBeInTheDocument()
    expect(screen.getByText("-1")).toBeInTheDocument()
    expect(screen.queryByRole("textbox", { name: "Editing src/App.tsx" })).not.toBeInTheDocument()
  })

  it("opens the editor for a changed file on request", async () => {
    const user = userEvent.setup()
    render(<ProjectFilesPanel cwd="/workspace/cogpit" onClose={vi.fn()} />)

    await user.click(await screen.findByRole("button", { name: "Changes" }))
    await user.click(await screen.findByRole("button", { name: /App\.tsx/ }))
    await screen.findByText("const value = 2")
    await user.click(screen.getByRole("button", { name: "Edit" }))

    expect(await screen.findByRole("textbox", { name: "Editing src/App.tsx" })).toHaveValue("const value = 1\n")
  })

  it("opens unchanged files without diffing them", async () => {
    const user = userEvent.setup()
    render(<ProjectFilesPanel cwd="/workspace/cogpit" onClose={vi.fn()} />)

    await user.click(await screen.findByRole("button", { name: /README\.md/ }))

    expect(await screen.findByLabelText("Preview of README.md")).toBeInTheDocument()
    expect(mocks.authFetch.mock.calls.some((call) => String(call[0]).startsWith("/api/git-diff"))).toBe(false)
  })

  describe("markdown files", () => {
    it("renders markdown by default and switches to the raw source for editing", async () => {
      const user = userEvent.setup()
      render(<ProjectFilesPanel cwd="/workspace/cogpit" onClose={vi.fn()} />)

      await user.click(await screen.findByRole("button", { name: /README\.md/ }))

      const preview = await screen.findByLabelText("Preview of README.md")
      expect(preview.querySelector("h1")).toHaveTextContent("Cogpit")
      expect(preview.querySelector("em")).toHaveTextContent("docs")
      expect(screen.queryByRole("textbox", { name: "Editing README.md" })).not.toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: "Edit" }))
      const editor = await screen.findByRole("textbox", { name: "Editing README.md" })
      expect(editor).toHaveValue("# Cogpit\n\nSome *docs*.\n")
      fireEvent.change(editor, { target: { value: "# Renamed\n" } })

      await user.click(screen.getByRole("button", { name: "Preview" }))
      expect((await screen.findByLabelText("Preview of README.md")).querySelector("h1")).toHaveTextContent("Renamed")
      expect(screen.getByText("Unsaved")).toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: "Save" }))
      await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument())
    })

    it("resolves relative images against the file's directory", async () => {
      const user = userEvent.setup()
      mocks.authFetch.mockImplementation((url: string) => {
        if (url.startsWith("/api/git-status")) return Promise.resolve(jsonResponse({ isRepository: false, files: [] }))
        if (url.startsWith("/api/project-files/tree")) return Promise.resolve(treeResponse(["docs/guide.md"], url))
        if (url.startsWith("/api/project-file?")) {
          const content = "![shot](./img/shot.png) ![up](../top.png) ![web](https://x.test/a.png)\n"
          return Promise.resolve(jsonResponse({ content, mtimeMs: 1, size: content.length }))
        }
        throw new Error(`Unexpected request: ${url}`)
      })
      render(<ProjectFilesPanel cwd="/workspace/cogpit/" onClose={vi.fn()} />)

      await user.click(await screen.findByRole("button", { name: "docs" }))
      await user.click(await screen.findByRole("button", { name: /guide\.md/ }))

      const preview = await screen.findByLabelText("Preview of docs/guide.md")
      const sources = [...preview.querySelectorAll("img")].map((img) => decodeURIComponent(img.getAttribute("src") ?? ""))
      expect(sources[0]).toContain("path=/workspace/cogpit/docs/img/shot.png")
      expect(sources[1]).toContain("path=/workspace/cogpit/top.png")
      expect(sources[2]).toBe("https://x.test/a.png")
    })

    it("opens the source directly when a line is requested", async () => {
      render(
        <ProjectFilesPanel
          cwd="/workspace/cogpit"
          onClose={vi.fn()}
          openRequest={{ file: "README.md", mode: "edit", line: 3, token: 1 }}
        />,
      )

      expect(await screen.findByRole("textbox", { name: "Editing README.md" })).toBeInTheDocument()
      expect(screen.queryByLabelText("Preview of README.md")).not.toBeInTheDocument()
    })

    it("does not offer a preview for other file types", async () => {
      const user = userEvent.setup()
      render(<ProjectFilesPanel cwd="/workspace/cogpit" onClose={vi.fn()} />)

      await user.click(await screen.findByRole("button", { name: "src" }))
      await user.click(await screen.findByRole("button", { name: /App\.tsx/ }))

      expect(await screen.findByRole("textbox", { name: "Editing src/App.tsx" })).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Preview" })).not.toBeInTheDocument()
    })
  })

  describe("file tree", () => {
    it("shows folders collapsed and lists their files on demand", async () => {
      const user = userEvent.setup()
      render(<ProjectFilesPanel cwd="/workspace/cogpit" onClose={vi.fn()} />)

      const folder = await screen.findByRole("button", { name: "src" })
      expect(folder).toHaveAttribute("aria-expanded", "false")
      expect(screen.getByRole("button", { name: /README\.md/ })).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: /App\.tsx/ })).not.toBeInTheDocument()

      await user.click(folder)
      expect(folder).toHaveAttribute("aria-expanded", "true")
      expect(await screen.findByRole("button", { name: /App\.tsx/ })).toHaveTextContent("M")

      await user.click(folder)
      expect(screen.queryByRole("button", { name: /App\.tsx/ })).not.toBeInTheDocument()
    })

    it("lists compacted folder chains under their full path", async () => {
      const user = userEvent.setup()
      const files = ["packages/app/src/index.ts", "packages/app/src/lib/util.ts"]
      mocks.authFetch.mockImplementation((url: string) => {
        if (url.startsWith("/api/git-status")) return Promise.resolve(jsonResponse({ isRepository: false, files: [] }))
        if (url.startsWith("/api/project-files/tree")) {
          const directory = new URL(url, "http://localhost").searchParams.get("dir")
          if (directory === "") return Promise.resolve(jsonResponse({ entries: [{ name: "packages/app/src", type: "directory" }] }))
          return Promise.resolve(treeResponse(files, url))
        }
        if (url.startsWith("/api/project-file?")) return Promise.resolve(jsonResponse({ content: "export {}\n", mtimeMs: 1, size: 10 }))
        throw new Error(`Unexpected request: ${url}`)
      })
      render(<ProjectFilesPanel cwd="/workspace/cogpit" onClose={vi.fn()} />)

      await user.click(await screen.findByRole("button", { name: "packages/app/src" }))
      await user.click(await screen.findByRole("button", { name: /index\.ts/ }))

      expect(await screen.findByRole("textbox", { name: "Editing packages/app/src/index.ts" })).toBeInTheDocument()
      expect(mocks.authFetch.mock.calls.some((call) => String(call[0]).includes("dir=packages%2Fapp%2Fsrc"))).toBe(true)
    })

    it("expands the folders leading to a file opened from elsewhere", async () => {
      render(
        <ProjectFilesPanel
          cwd="/workspace/cogpit"
          onClose={vi.fn()}
          openRequest={{ file: "src/App.tsx", mode: "edit", token: 1 }}
        />,
      )

      expect(await screen.findByRole("button", { name: /App\.tsx/ })).toHaveAttribute("aria-current", "true")
      expect(screen.getByRole("button", { name: "src" })).toHaveAttribute("aria-expanded", "true")
    })

    it("warns when the listing was cut short", async () => {
      mocks.authFetch.mockImplementation((url: string) => {
        if (url.startsWith("/api/git-status")) return Promise.resolve(jsonResponse({ isRepository: false, files: [] }))
        if (url.startsWith("/api/project-files/tree")) {
          return Promise.resolve(jsonResponse({ entries: [{ name: "README.md", type: "file" }], scanLimited: true }))
        }
        throw new Error(`Unexpected request: ${url}`)
      })
      render(<ProjectFilesPanel cwd="/workspace/cogpit" onClose={vi.fn()} />)

      expect(await screen.findByText("This project is too large to scan completely.")).toBeInTheDocument()
    })

    it("switches to the flat ranked list while filtering", async () => {
      const user = userEvent.setup()
      render(<ProjectFilesPanel cwd="/workspace/cogpit" onClose={vi.fn()} />)

      await screen.findByRole("button", { name: "src" })
      await user.type(screen.getByRole("textbox", { name: "Search project files" }), "app")

      expect(await screen.findByRole("button", { name: /App\.tsx/ })).toHaveTextContent("src")
      expect(screen.queryByRole("button", { name: "src" })).not.toBeInTheDocument()
    })
  })

  it("reports how many matches the result limit hid", async () => {
    const user = userEvent.setup()
    mocks.authFetch.mockImplementation((url: string) => {
      if (url.startsWith("/api/git-status")) return Promise.resolve(jsonResponse({ isRepository: false, files: [] }))
      if (url.startsWith("/api/project-files/tree")) return Promise.resolve(treeResponse(PROJECT_FILES, url))
      return Promise.resolve(jsonResponse({ files: PROJECT_FILES, totalMatches: 42, scanLimited: false }))
    })
    render(<ProjectFilesPanel cwd="/workspace/cogpit" onClose={vi.fn()} />)

    await user.type(await screen.findByRole("textbox", { name: "Search project files" }), "a")
    expect(await screen.findByText(/Showing 2 of 42 matches/)).toBeInTheDocument()
  })

  it("keeps quiet when every match is on screen", async () => {
    const user = userEvent.setup()
    render(<ProjectFilesPanel cwd="/workspace/cogpit" onClose={vi.fn()} />)

    await user.type(await screen.findByRole("textbox", { name: "Search project files" }), "a")
    await screen.findByRole("button", { name: /App\.tsx/ })
    expect(screen.queryByText(/matches/)).not.toBeInTheDocument()
  })

  it("bypasses the server listing cache when refreshed", async () => {
    const user = userEvent.setup()
    render(<ProjectFilesPanel cwd="/workspace/cogpit" onClose={vi.fn()} />)

    await screen.findByRole("button", { name: /README\.md/ })
    const listCallsBefore = mocks.authFetch.mock.calls.filter((call) => String(call[0]).includes("refresh=1"))
    expect(listCallsBefore).toHaveLength(0)

    await user.click(screen.getByRole("button", { name: "Refresh files and git status" }))

    await waitFor(() => {
      expect(mocks.authFetch.mock.calls.some((call) => String(call[0]).includes("refresh=1"))).toBe(true)
    })
    expect(mocks.authFetch.mock.calls.filter((call) => String(call[0]).startsWith("/api/git-status"))).toHaveLength(2)
  })

  it("sends selected file lines back to the composer context", async () => {
    const user = userEvent.setup()
    const onAddToPrompt = vi.fn()
    render(<ProjectFilesPanel cwd="/workspace/cogpit" onClose={vi.fn()} onAddToPrompt={onAddToPrompt} />)

    await user.click(await screen.findByRole("button", { name: "src" }))
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

  describe("routed open requests", () => {
    it("opens the requested file with the caret on the requested line", async () => {
      mocks.authFetch.mockImplementation((url: string) => {
        if (url.startsWith("/api/git-status")) return Promise.resolve(jsonResponse({ isRepository: false, files: [] }))
        if (url.startsWith("/api/project-files/tree")) return Promise.resolve(treeResponse(["src/App.tsx"], url))
        if (url.startsWith("/api/project-file?")) {
          return Promise.resolve(jsonResponse({ content: "one\ntwo\nthree\n", mtimeMs: 10, size: 14 }))
        }
        throw new Error(`Unexpected request: ${url}`)
      })
      render(
        <ProjectFilesPanel
          cwd="/workspace/cogpit"
          onClose={vi.fn()}
          openRequest={{ file: "src/App.tsx", mode: "edit", line: 3, token: 1 }}
        />,
      )

      const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Editing src/App.tsx" })
      await waitFor(() => expect(editor.selectionStart).toBe("one\ntwo\n".length))
    })

    it("opens the requested file straight into its diff", async () => {
      render(
        <ProjectFilesPanel
          cwd="/workspace/cogpit"
          onClose={vi.fn()}
          openRequest={{ file: "src/App.tsx", mode: "diff", token: 1 }}
        />,
      )

      await waitFor(() => {
        expect(mocks.authFetch.mock.calls.some((call) => String(call[0]).startsWith("/api/git-diff"))).toBe(true)
      })
      expect(screen.queryByRole("textbox", { name: "Editing src/App.tsx" })).toBeNull()
    })

    it("guards a routed open behind unsaved changes", async () => {
      const user = userEvent.setup()
      const { rerender } = render(
        <ProjectFilesPanel
          cwd="/workspace/cogpit"
          onClose={vi.fn()}
          openRequest={{ file: "src/App.tsx", mode: "edit", token: 1 }}
        />,
      )

      const editor = await screen.findByRole("textbox", { name: "Editing src/App.tsx" })
      fireEvent.change(editor, { target: { value: "const value = 2\n" } })
      expect(screen.getByText("Unsaved")).toBeInTheDocument()

      rerender(
        <ProjectFilesPanel
          cwd="/workspace/cogpit"
          onClose={vi.fn()}
          openRequest={{ file: "README.md", mode: "edit", token: 2 }}
        />,
      )

      expect(await screen.findByText("Discard unsaved changes?")).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Discard changes" }))
      expect(await screen.findByLabelText("Preview of README.md")).toBeInTheDocument()
    })
  })
})
