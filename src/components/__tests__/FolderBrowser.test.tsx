import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProjectSwitcherList, type ProjectSwitcherView } from "@/components/ProjectSwitcherList"
import type { ProjectInfo } from "@/components/Dashboard/types"

/**
 * The folder browser as the project switcher shows it, against a fake server
 * with a small folder tree: /home/me holds code and notes, and code holds a
 * folder that is already a project.
 */

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  jsonFetch: vi.fn(),
  hostName: null as string | null,
  tree: {} as Record<string, string[]>,
  failing: null as { status: number; error: string } | null,
  confined: false,
}))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch, jsonFetch: mocks.jsonFetch }))
vi.mock("@/hooks/useProjectNames", () => ({ useProjectNames: () => ({ names: {} }) }))
vi.mock("@/hooks/useFolderHostName", () => ({ useFolderHostName: () => mocks.hostName }))
vi.mock("@/components/ProjectFavicon", () => ({ ProjectFavicon: () => null }))

// cmdk scrolls the highlighted item into view, which jsdom does not implement.
Element.prototype.scrollIntoView = vi.fn()

const ROOT = "/home/me"
const PROJECT: ProjectInfo = {
  dirName: "-home-me-code-app",
  path: "/home/me/code/app",
  shortName: "app",
  sessionCount: 2,
  lastModified: null,
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function parentOf(path: string): string | null {
  if (path === "/") return null
  return path.slice(0, path.lastIndexOf("/")) || "/"
}

function listing(path: string): Response {
  const names = mocks.tree[path]
  if (!names) return json({ error: `The folder ${path} does not exist`, code: "NOT_FOUND" }, 404)
  return json({
    path,
    parent: mocks.confined && path === ROOT ? null : parentOf(path),
    root: ROOT,
    confined: mocks.confined,
    folders: [...names].sort().map((name) => ({ name, path: `${path === "/" ? "" : path}/${name}` })),
    truncated: false,
  })
}

/** The paths the browser has listed, in order. */
function listed(): string[] {
  return mocks.authFetch.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.startsWith("/api/folders"))
    .map((url) => new URL(url, "http://cogpit.test").searchParams.get("path") ?? "(root)")
}

beforeEach(() => {
  mocks.hostName = null
  mocks.failing = null
  mocks.confined = false
  mocks.tree = {
    "/": ["home"],
    "/home": ["me"],
    [ROOT]: ["code", "notes"],
    "/home/me/code": ["app"],
    "/home/me/code/app": [],
    "/home/me/notes": [],
  }
  mocks.authFetch.mockReset().mockImplementation(async (url: string) => {
    if (mocks.failing) return json({ error: mocks.failing.error }, mocks.failing.status)
    return listing(new URL(url, "http://cogpit.test").searchParams.get("path") ?? ROOT)
  })
  mocks.jsonFetch.mockReset().mockImplementation(async (_url: string, { parent, name }: { parent: string; name: string }) => {
    const path = `${parent}/${name}`
    if (mocks.tree[path]) return json({ error: `${name} already exists in ${parent}`, code: "CONFLICT" }, 409)
    mocks.tree[parent].push(name)
    mocks.tree[path] = []
    return json({ path }, 201)
  })
})

afterEach(cleanup)

function renderSwitcher(initialView?: ProjectSwitcherView) {
  const props = { onNewSession: vi.fn(), onNewFolder: vi.fn() }
  render(<ProjectSwitcherList projects={[PROJECT]} defaultAgentKind="claude" initialView={initialView} {...props} />)
  return props
}

async function openBrowser(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("option", { name: /Browse folders/ }))
  await screen.findByRole("option", { name: /code/ })
}

const crumbs = () => within(screen.getByRole("navigation", { name: "breadcrumb" }))

describe("the switcher's way into the folder browser", () => {
  it("names the machine the folders are on, and nothing on this one", () => {
    renderSwitcher()
    expect(screen.getByRole("option", { name: "Browse folders…" })).toBeInTheDocument()

    cleanup()
    mocks.hostName = "Mac mini"
    renderSwitcher()
    expect(screen.getByRole("option", { name: "Browse folders on Mac mini…" })).toBeInTheDocument()
  })

  it("keeps Enter on the most recent project, which arrives after the list opens", async () => {
    const user = userEvent.setup()
    const recent: ProjectInfo = { ...PROJECT, dirName: "-Users-Me-App", path: "/Users/Me/App" }
    const onNewSession = vi.fn()
    const list = (projects: ProjectInfo[]) => (
      <ProjectSwitcherList projects={projects} onNewSession={onNewSession} onNewFolder={vi.fn()} defaultAgentKind="claude" />
    )
    const { rerender } = render(list([]))
    rerender(list([recent, PROJECT]))

    await user.keyboard("{Enter}")

    expect(onNewSession).toHaveBeenCalledWith(recent.dirName, recent.path)
  })

  it("opens straight on the browser when asked to", async () => {
    mocks.hostName = "Mac mini"
    renderSwitcher("folders")
    expect(await screen.findByText("Folders on Mac mini")).toBeInTheDocument()
    expect(listed()).toEqual(["(root)"])
  })

  it("goes back to the project list", async () => {
    const user = userEvent.setup()
    renderSwitcher()
    await openBrowser(user)

    await user.click(screen.getByRole("button", { name: "Back to projects" }))

    expect(screen.getByPlaceholderText("Search projects, paste a folder path, or browse")).toBeInTheDocument()
  })
})

describe("FolderBrowser", () => {
  it("starts in the projects root, lists its folders and marks projects", async () => {
    const user = userEvent.setup()
    renderSwitcher()
    await openBrowser(user)

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["code", "notes"])
    expect(crumbs().getByText("me")).toHaveAttribute("aria-current", "page")

    await user.click(screen.getByRole("option", { name: /code/ }))

    expect(await screen.findByRole("option", { name: /app/ })).toHaveTextContent("Project")
    expect(listed()).toEqual(["(root)", "/home/me/code"])
  })

  it("walks the tree from the keyboard, each listing starting on its first folder", async () => {
    const user = userEvent.setup()
    renderSwitcher("folders")
    await screen.findByRole("option", { name: /code/ })

    await user.keyboard("{ArrowDown}{Enter}")
    await screen.findByText("No folders here")
    await user.keyboard("{Backspace}")
    await screen.findByRole("option", { name: /notes/ })
    expect(screen.getByRole("option", { name: /code/ })).toHaveAttribute("aria-selected", "true")
    await user.keyboard("{Enter}")
    await screen.findByRole("option", { name: /app/ })

    expect(listed()).toEqual(["(root)", "/home/me/notes", "/home/me", "/home/me/code"])
  })

  it("keeps the filter focused when a folder is clicked", async () => {
    const user = userEvent.setup()
    renderSwitcher("folders")
    await user.click(await screen.findByRole("option", { name: /code/ }))
    await screen.findByRole("option", { name: /app/ })

    expect(screen.getByRole("combobox", { name: "Filter folders" })).toHaveFocus()
  })

  it("goes up by the breadcrumb, by Backspace, and home by the root button", async () => {
    const user = userEvent.setup()
    renderSwitcher()
    await openBrowser(user)
    await user.click(screen.getByRole("option", { name: /code/ }))
    await screen.findByRole("option", { name: /app/ })

    await user.click(crumbs().getByRole("button", { name: "home" }))
    await screen.findByRole("option", { name: /^me/ })

    await user.keyboard("{Backspace}")
    await screen.findByRole("option", { name: /^home/ })
    expect(screen.queryByRole("button", { name: "Go to the projects root" })).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Go to the projects root" }))
    await screen.findByRole("option", { name: /notes/ })
    expect(listed()).toEqual(["(root)", "/home/me/code", "/home", "/", "(root)"])
  })

  it("goes no higher than the projects root for a caller confined to it", async () => {
    mocks.confined = true
    const user = userEvent.setup()
    renderSwitcher()
    await openBrowser(user)
    await user.click(screen.getByRole("option", { name: /code/ }))
    await screen.findByRole("option", { name: /app/ })

    expect(crumbs().getAllByRole("listitem").map((item) => item.textContent)).toEqual(["me", "code"])

    await user.click(crumbs().getByRole("button", { name: "me" }))
    await screen.findByRole("option", { name: /notes/ })
    await user.keyboard("{Backspace}")
    expect(crumbs().getAllByRole("listitem").map((item) => item.textContent)).toEqual(["me"])
    expect(listed()).toEqual(["(root)", "/home/me/code", "/home/me"])
  })

  it("filters the listed folders by name", async () => {
    const user = userEvent.setup()
    renderSwitcher()
    await openBrowser(user)

    await user.type(screen.getByRole("combobox", { name: "Filter folders" }), "NOT")

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["notes"])
    await user.clear(screen.getByRole("combobox", { name: "Filter folders" }))
    await user.type(screen.getByRole("combobox", { name: "Filter folders" }), "zzz")
    expect(screen.getByText("No folder matches")).toBeInTheDocument()
  })

  it("starts the session in the folder it shows, by button or Cmd/Ctrl+Enter", async () => {
    const user = userEvent.setup()
    const props = renderSwitcher()
    await openBrowser(user)
    await user.click(screen.getByRole("option", { name: /notes/ }))
    await screen.findByText("No folders here")

    await user.click(screen.getByRole("button", { name: "Start session here" }))
    await user.keyboard("{Control>}{Enter}{/Control}")

    expect(props.onNewFolder.mock.calls).toEqual([["/home/me/notes"], ["/home/me/notes"]])
  })

  it("makes a new folder, then opens it ready to start there", async () => {
    const user = userEvent.setup()
    const props = renderSwitcher()
    await openBrowser(user)

    await user.click(screen.getByRole("button", { name: "New folder" }))
    await user.type(screen.getByRole("textbox", { name: "New folder name" }), "  fresh-idea {Enter}")

    await screen.findByText("No folders here")
    expect(mocks.jsonFetch).toHaveBeenCalledWith("/api/folders", { parent: ROOT, name: "fresh-idea" })
    expect(crumbs().getByText("fresh-idea")).toHaveAttribute("aria-current", "page")
    await user.click(screen.getByRole("button", { name: "Start session here" }))
    expect(props.onNewFolder).toHaveBeenCalledWith("/home/me/fresh-idea")
  })

  it("explains a name it refuses, before and after asking the server", async () => {
    const user = userEvent.setup()
    renderSwitcher()
    await openBrowser(user)
    await user.click(screen.getByRole("button", { name: "New folder" }))
    const name = screen.getByRole("textbox", { name: "New folder name" })

    await user.type(name, "a/b{Enter}")
    expect(screen.getByRole("alert")).toHaveTextContent("A folder name cannot contain / or \\")
    expect(mocks.jsonFetch).not.toHaveBeenCalled()

    await user.clear(name)
    await user.type(name, "code{Enter}")
    expect(await screen.findByRole("alert")).toHaveTextContent("code already exists in /home/me")

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("textbox", { name: "New folder name" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "New folder" })).toBeInTheDocument()
  })

  it("shows why a folder cannot be read and tries again", async () => {
    const user = userEvent.setup()
    mocks.failing = { status: 403, error: "Cogpit is not allowed to open /home/me" }
    renderSwitcher("folders")

    expect(await screen.findByText("Cogpit is not allowed to open /home/me")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Start session here" })).toBeDisabled()

    mocks.failing = null
    await user.click(screen.getByRole("button", { name: "Try again" }))
    expect(await screen.findByRole("option", { name: /code/ })).toBeInTheDocument()
  })

  it("says so when the device's Cogpit predates the folder browser", async () => {
    mocks.failing = { status: 404, error: "Not found" }
    renderSwitcher("folders")
    expect(await screen.findByText("Browsing folders needs a newer Cogpit on this machine.")).toBeInTheDocument()
  })

  it("never starts in a folder it is still leaving", async () => {
    const user = userEvent.setup()
    const props = renderSwitcher()
    await openBrowser(user)
    let answer: (response: Response) => void = () => {}
    mocks.authFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve }))

    await user.click(screen.getByRole("option", { name: /code/ }))

    expect(screen.getByRole("button", { name: "Start session here" })).toBeDisabled()
    await user.keyboard("{Control>}{Enter}{/Control}")
    expect(props.onNewFolder).not.toHaveBeenCalled()
    answer(listing("/home/me/code"))
    await waitFor(() => expect(screen.getByRole("button", { name: "Start session here" })).toBeEnabled())
  })
})
