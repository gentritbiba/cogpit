import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProjectSwitcherModal } from "@/components/ProjectSwitcherModal"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))
vi.mock("@/hooks/useProjectNames", () => ({ useProjectNames: () => ({ names: {} }) }))

describe("ProjectSwitcherModal", () => {
  beforeEach(() => {
    mocks.authFetch.mockResolvedValue({ ok: true, json: async () => [] })
  })

  it("starts a session from a pasted absolute folder path", async () => {
    const user = userEvent.setup()
    const onNewFolder = vi.fn()
    const onClose = vi.fn()

    render(
      <ProjectSwitcherModal
        open
        onClose={onClose}
        onNewSession={vi.fn()}
        onNewFolder={onNewFolder}
        defaultAgentKind="codex"
        currentProjectDirName={null}
        currentProjectCwd={null}
      />,
    )

    await user.type(
      screen.getByPlaceholderText("Search projects or paste an absolute path..."),
      "/workspace/new-project",
    )
    await user.click(screen.getByRole("option", { name: /Start in this folder/ }))

    expect(onNewFolder).toHaveBeenCalledWith("/workspace/new-project")
    expect(onClose).toHaveBeenCalled()
  })

  it("labels a new-folder session with the selected Copilot provider", async () => {
    const user = userEvent.setup()
    render(
      <ProjectSwitcherModal
        open
        onClose={vi.fn()}
        onNewSession={vi.fn()}
        onNewFolder={vi.fn()}
        defaultAgentKind="copilot"
        currentProjectDirName={null}
        currentProjectCwd={null}
      />,
    )

    await user.type(
      screen.getByPlaceholderText("Search projects or paste an absolute path..."),
      "/workspace/copilot-project",
    )

    expect(screen.getByRole("option", { name: /GitHub Copilot/ })).toBeInTheDocument()
  })
})
