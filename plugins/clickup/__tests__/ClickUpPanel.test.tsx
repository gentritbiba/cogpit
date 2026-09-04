import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  ClickUpListTasksResponse,
  ClickUpMyTasksResponse,
  ClickUpTask,
} from "../../../shared/contracts/clickup"
import type { WorkspacePanelContext } from "@/plugin-api"

const storeMocks = vi.hoisted(() => ({
  useClickUpStatus: vi.fn(),
  useClickUpMyTasks: vi.fn(),
  useClickUpListTasks: vi.fn(),
  saveClickUpToken: vi.fn(),
  forgetClickUpToken: vi.fn(),
  linkClickUpProject: vi.fn(),
  fetchClickUpSpaces: vi.fn(),
  fetchClickUpLists: vi.fn(),
  toErrorResponse: vi.fn((error: unknown, fallback: string) => ({
    error: (error as { error?: string }).error ?? fallback,
    code: "clickup_api_failed",
  })),
}))

vi.mock("../clickupStore", () => storeMocks)

import { ClickUpPanel } from "../ClickUpPanel"

const DAY = 24 * 60 * 60 * 1000
const viewer = { id: 7, username: "Gentrit", initials: "GB", color: "#123456" }
const workspace = { id: "2280762", name: "Honest Digital" }

function task(overrides: Partial<ClickUpTask> & { id: string; name: string }): ClickUpTask {
  return {
    customId: null,
    description: "",
    status: { name: "to do", type: "open", color: "#d3d3d3", order: 0 },
    priority: null,
    url: `https://app.clickup.com/t/${overrides.id}`,
    assignees: [viewer],
    tags: [],
    parentId: null,
    listId: "1",
    listName: "Sprint 12",
    folderName: "CMS",
    spaceId: "9",
    createdAt: Date.now() - 5 * DAY,
    updatedAt: Date.now() - DAY,
    dueAt: null,
    startAt: null,
    closedAt: null,
    ...overrides,
  }
}

const myTasks: ClickUpMyTasksResponse = {
  workspace,
  viewer,
  truncated: false,
  tasks: [
    task({ id: "a", name: "Fix inventory feed", customId: "HSEO-42", dueAt: Date.now() - 2 * DAY, priority: "high", description: "Feed drops used vehicles." }),
    task({ id: "b", name: "Write release notes", dueAt: Date.now() + 3 * DAY, status: { name: "in progress", type: "custom", color: "#4194f6", order: 1 } }),
    task({ id: "c", name: "Tidy backlog", listName: "Backlog", folderName: null }),
  ],
}

const listTasks: ClickUpListTasksResponse = {
  workspace,
  viewer,
  truncated: false,
  list: { id: "901711539677", name: "Sprint 12", folderName: "CMS", spaceId: "9", statuses: [], url: "https://app.clickup.com/v/li/901711539677" },
  tasks: [
    task({ id: "p1", name: "Ship plugin" }),
    task({ id: "p2", name: "Old chore", status: { name: "complete", type: "closed", color: "#6bc950", order: 3 }, closedAt: Date.now() - DAY }),
  ],
}

const composePrompt = vi.fn()

const context: WorkspacePanelContext = {
  session: null,
  sessionChangeKey: 0,
  projectPath: "/repo",
  hasFileChanges: false,
  canAccessHostFiles: true,
  composePrompt,
}

function resource<T>(data: T | null, error: { error: string; code: string } | null = null) {
  return { data, error, loading: false, refreshing: false, refresh: vi.fn().mockResolvedValue(undefined) }
}

function renderPanel() {
  return render(<ClickUpPanel context={context} active closePanel={vi.fn()} openPanel={vi.fn()} />)
}

describe("ClickUpPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeMocks.useClickUpStatus.mockReturnValue(resource({ configured: true, tokenFromEnv: false, viewer, workspace }))
    storeMocks.useClickUpMyTasks.mockReturnValue(resource(myTasks))
    storeMocks.useClickUpListTasks.mockReturnValue(resource(listTasks))
    storeMocks.saveClickUpToken.mockResolvedValue({ configured: true, tokenFromEnv: false, viewer, workspace })
    storeMocks.linkClickUpProject.mockResolvedValue(undefined)
    storeMocks.fetchClickUpSpaces.mockResolvedValue({ workspace, spaces: [{ id: "9", name: "CMS Space" }] })
    storeMocks.fetchClickUpLists.mockResolvedValue({ spaceId: "9", lists: [{ id: "901711539677", name: "Sprint 12", folderName: "CMS" }] })
  })

  it("asks for a token until ClickUp is connected", async () => {
    storeMocks.useClickUpStatus.mockReturnValue(resource({ configured: false, tokenFromEnv: false, viewer: null, workspace: null }))
    storeMocks.useClickUpMyTasks.mockReturnValue(resource(null))
    renderPanel()

    expect(screen.getByRole("heading", { name: "Connect ClickUp" })).toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: /My tasks/ })).not.toBeInTheDocument()
    expect(storeMocks.useClickUpMyTasks).toHaveBeenLastCalledWith(false)

    const connect = screen.getByRole("button", { name: "Connect" })
    expect(connect).toBeDisabled()
    await userEvent.type(screen.getByLabelText("Personal API token"), "pk_12345678_ABCDEFGHIJKLMNOP")
    await userEvent.click(connect)
    expect(storeMocks.saveClickUpToken).toHaveBeenCalledWith("pk_12345678_ABCDEFGHIJKLMNOP")
  })

  it("shows the token error inline when ClickUp rejects it", async () => {
    storeMocks.useClickUpStatus.mockReturnValue(resource({ configured: false, tokenFromEnv: false, viewer: null, workspace: null }))
    storeMocks.saveClickUpToken.mockRejectedValue({ error: "ClickUp rejected the API token", code: "clickup_auth_failed" })
    renderPanel()

    await userEvent.type(screen.getByLabelText("Personal API token"), "pk_bad")
    await userEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("ClickUp rejected the API token")
  })

  it("hides Disconnect when the token comes from the environment", () => {
    storeMocks.useClickUpStatus.mockReturnValue(resource({ configured: true, tokenFromEnv: true, viewer, workspace }))
    renderPanel()
    expect(screen.queryByRole("button", { name: "Disconnect ClickUp" })).not.toBeInTheDocument()
  })

  it("lists my tasks overdue first and filters them", async () => {
    renderPanel()

    expect(screen.getByText("Honest Digital · Gentrit")).toBeInTheDocument()
    const articles = screen.getAllByRole("article")
    expect(articles.map((article) => article.getAttribute("aria-label")))
      .toEqual(["Fix inventory feed", "Write release notes", "Tidy backlog"])
    expect(within(screen.getByRole("tab", { name: /My tasks/ })).getByText("1")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /^Overdue/ }))
    expect(screen.getAllByRole("article")).toHaveLength(1)

    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }))
    await userEvent.type(screen.getByRole("searchbox", { name: "Search tasks" }), "backlog")
    expect(screen.getAllByRole("article").map((article) => article.getAttribute("aria-label"))).toEqual(["Tidy backlog"])
  })

  it("expands a task and hands it to the composer", async () => {
    renderPanel()

    await userEvent.click(screen.getByRole("button", { name: "Fix inventory feed: to do" }))
    expect(screen.getByText("Feed drops used vehicles.")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Add to prompt" }))
    expect(composePrompt).toHaveBeenCalledWith(
      "Work on ClickUp task HSEO-42: Fix inventory feed\nhttps://app.clickup.com/t/a\n\nFeed drops used vehicles.",
    )
  })

  it("shows the linked list with closed work folded away", async () => {
    renderPanel()

    await userEvent.click(screen.getByRole("tab", { name: /This project/ }))
    const panel = screen.getAllByRole("tabpanel").find((candidate) => !candidate.hasAttribute("inert"))!
    expect(within(panel).getByRole("link", { name: "CMS › Sprint 12" })).toBeInTheDocument()
    expect(within(panel).getAllByRole("article").map((article) => article.getAttribute("aria-label"))).toEqual(["Ship plugin"])

    await userEvent.click(within(panel).getByRole("button", { name: /Closed/ }))
    expect(within(panel).getByRole("article", { name: "Old chore" })).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Unlink this project from ClickUp" }))
    expect(storeMocks.linkClickUpProject).toHaveBeenCalledWith("/repo", null)
  })

  it("links an unlinked project from a pasted list URL", async () => {
    storeMocks.useClickUpListTasks.mockReturnValue(
      resource(null, { error: "This project is not linked to a ClickUp list", code: "project_unlinked" }),
    )
    renderPanel()

    await userEvent.click(screen.getByRole("tab", { name: /This project/ }))
    await userEvent.type(screen.getByLabelText("List URL or id"), "https://app.clickup.com/2280762/v/li/901711539677")
    await userEvent.click(screen.getByRole("button", { name: "Link" }))
    expect(storeMocks.linkClickUpProject).toHaveBeenCalledWith("/repo", "901711539677")
    expect(storeMocks.fetchClickUpSpaces).toHaveBeenCalled()
  })
})
