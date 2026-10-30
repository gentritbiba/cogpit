import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { WorktreeSetupPanel } from "../WorktreeSetupPanel"
import type { WorktreeSetupSnapshot } from "../../../shared/contracts/worktreeSetup"

const mocks = vi.hoisted(() => ({ snapshot: null as WorktreeSetupSnapshot | null, configure: vi.fn(), act: vi.fn(), allowed: true }))
vi.mock("@/hooks/useCapability", () => ({ useCapability: () => mocks.allowed }))
vi.mock("@/hooks/useScriptDiscovery", () => ({ useScriptDiscovery: () => ({ scripts: [{ name: "bootstrap", command: "setup dependencies", dirLabel: "root/" }] }) }))
vi.mock("@/hooks/useWorktreeSetup", () => ({ useWorktreeSetup: () => ({ snapshot: mocks.snapshot, error: null, configure: mocks.configure, act: mocks.act }) }))
beforeEach(() => {
  mocks.snapshot = { projectCwd: "/repo", recipe: null, operations: [] }
  mocks.allowed = true; mocks.configure.mockReset().mockResolvedValue(undefined); mocks.act.mockReset().mockResolvedValue(undefined)
})

describe("worktree setup controls", () => {
  it("requires explicit trust before saving a command and never executes script suggestions", async () => {
    const user = userEvent.setup()
    render(<WorktreeSetupPanel projectCwd="/repo" />)
    fireEvent.click(screen.getByText(/Worktree setup recipe/))
    await user.type(screen.getByLabelText("Project setup command"), "bun install")
    expect(screen.getByRole("button", { name: "Save setup recipe" })).toBeDisabled()
    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByRole("button", { name: "Save setup recipe" }))
    await waitFor(() => expect(mocks.configure).toHaveBeenCalledWith("bun install", true, 600000))
    await user.selectOptions(screen.getByRole("combobox"), "bootstrap")
    expect(screen.getByLabelText("Project setup command")).toHaveValue("bun run bootstrap")
    expect(screen.getByRole("checkbox")).not.toBeChecked()
    expect(screen.getByRole("button", { name: "Save setup recipe" })).toBeDisabled()
    expect(mocks.configure).toHaveBeenCalledTimes(1)
  })
  it("shows reconnect output/error and offers retry and cancellation", async () => {
    const user = userEvent.setup()
    mocks.snapshot!.operations = [{ id: "operation", worktreeName: "feature", projectCwd: "/repo", cwd: "/repo/.worktrees/feature", stage: "failed", attempt: 1, command: "bun install", exitCode: 7, output: "dependency failed", outputTruncated: true, error: "Setup exited with code 7", createdAt: 1, updatedAt: 2 }]
    render(<WorktreeSetupPanel projectCwd="/repo" progressOnly />)
    expect(screen.getByText(/first prompt is waiting/)).toBeInTheDocument()
    expect(screen.getByLabelText("Setup output")).toHaveTextContent("dependency failed")
    expect(screen.getByText(/older output trimmed/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Retry setup" }))
    await waitFor(() => expect(mocks.act).toHaveBeenCalledWith("operation", "retry"))
    await user.click(screen.getByRole("button", { name: "Cancel startup" }))
    expect(mocks.act).toHaveBeenLastCalledWith("operation", "cancel")
  })
  it("retains configuration after a failed save", async () => {
    const user = userEvent.setup()
    mocks.configure.mockRejectedValue(new Error("Disk full"))
    render(<WorktreeSetupPanel projectCwd="/repo" />)
    fireEvent.click(screen.getByText(/Worktree setup recipe/))
    await user.type(screen.getByLabelText("Project setup command"), "bun install")
    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByRole("button", { name: "Save setup recipe" }))
    await screen.findByText("Disk full")
    expect(screen.getByLabelText("Project setup command")).toHaveValue("bun install")
  })
  it("hides host configuration from callers without host-file capability", () => {
    mocks.allowed = false
    const { container } = render(<WorktreeSetupPanel projectCwd="/repo" />)
    expect(container).toBeEmptyDOMElement()
  })
})
