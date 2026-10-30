import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { WorktreeSetupSnapshot } from "@cogpit/plugin-integrations/worktreeSetup"
import { WorktreeSetupPanel, type WorktreeSetupApi } from "../WorktreeSetupPanel"

const failed: WorktreeSetupSnapshot = {
  recipe: { command: "bun install", timeoutMs: 600_000, revision: "r1", configuredAt: 1 },
  operations: [{ id: "op-1", worktreeName: "feature", stage: "failed", command: "bun install", attempt: 1, output: "\u001b[31mboom\u001b[0m", outputTruncated: false, exitCode: 1, error: "Setup command exited with code 1", createdAt: 1, updatedAt: 2 }],
}
function api(snapshot = failed): WorktreeSetupApi & { [K in keyof WorktreeSetupApi]: ReturnType<typeof vi.fn> } {
  return {
    snapshot: vi.fn(async () => snapshot),
    scripts: vi.fn(async () => [{ name: "bootstrap", command: "bun install && bun run build" }]),
    propose: vi.fn(async () => {}),
    act: vi.fn(async () => ({ ...snapshot, operations: [] })),
  }
}
afterEach(cleanup)

describe("Worktree setup plugin panel", () => {
  it("shows a waiting startup with its output and lets the user retry it", async () => {
    const value = api()
    render(<WorktreeSetupPanel api={value} active />)
    expect(await screen.findByText("feature · Setup failed — first prompt is waiting")).toBeTruthy()
    expect(screen.getByLabelText("Setup output").textContent).toBe("boom")
    await userEvent.click(screen.getByRole("button", { name: "Retry setup" }))
    expect(value.act).toHaveBeenCalledWith("op-1", "retry")
  })
  it("sends an edited command for Cogpit's confirmation instead of saving it", async () => {
    const value = api({ recipe: null, operations: [] })
    render(<WorktreeSetupPanel api={value} active />)
    await userEvent.selectOptions(await screen.findByRole("combobox"), "bootstrap")
    const button = screen.getByRole("button", { name: "Review and save" })
    // Sandboxed frames without allow-forms never fire submit, so the action must not depend on a form.
    expect(button.getAttribute("type")).toBe("button")
    expect(document.querySelector("form")).toBeNull()
    await userEvent.click(button)
    expect(value.propose).toHaveBeenCalledWith("bun run bootstrap", 600_000)
    expect(await screen.findByText("Confirm the command in Cogpit's dialog to save it.")).toBeTruthy()
  })
  it("stops polling while hidden", async () => {
    const value = api()
    render(<WorktreeSetupPanel api={value} active={false} />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(value.snapshot).not.toHaveBeenCalled()
  })
})
