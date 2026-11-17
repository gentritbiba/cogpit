import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn(), openProjectTerminal: vi.fn(), terminal: true }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))
vi.mock("@/lib/openTerminal", () => ({ openProjectTerminal: mocks.openProjectTerminal }))
vi.mock("@/hooks/useCapability", () => ({ useCapability: (capability: string) => capability === "terminal" && mocks.terminal }))

import { ErrorBanner } from "../ErrorBanner"
import { agentConfigInvalidMessage, agentTerminalOnlyMessage } from "../../../../shared/session/agentFailures"

const PATH = "/Users/me/.claude.json"
const BACKUP = "/Users/me/.claude/backups/.claude.json.backup.1763400000000"
const CLI_TEXT = `Configuration error in ${PATH}: JSON Parse error: Property name must be a string literal`

beforeEach(() => {
  mocks.authFetch.mockReset()
  mocks.openProjectTerminal.mockReset()
  mocks.terminal = true
})

describe("ErrorBanner for a config file the agent would not start with", () => {
  it("restores the backup once the reader confirms", async () => {
    mocks.authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ path: PATH, backupPath: BACKUP }), { status: 200 }))
    render(<ErrorBanner error={agentConfigInvalidMessage("claude", { path: PATH, backupPath: BACKUP }, CLI_TEXT)} agentKind="claude" />)

    expect(screen.getByText("Claude Code can't start: a config file isn't valid JSON.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Restore from backup" }))
    expect(mocks.authFetch).not.toHaveBeenCalled()
    expect(await screen.findByText("The backup replaces the file. Changes made since that backup are lost.")).toBeInTheDocument()
    expect(screen.getByText(PATH)).toBeInTheDocument()
    expect(screen.getByText(BACKUP)).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Restore" }))

    expect(await screen.findByText("Restored from the backup. Send your message again.")).toBeInTheDocument()
    expect(mocks.authFetch).toHaveBeenCalledWith("/api/agent-check/restore-config", expect.objectContaining({ method: "POST", body: JSON.stringify({ path: PATH }) }))
  })

  it("says why a restore was refused", async () => {
    mocks.authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "The backup is not valid JSON either" }), { status: 422 }))
    render(<ErrorBanner error={agentConfigInvalidMessage("claude", { path: PATH, backupPath: BACKUP }, CLI_TEXT)} agentKind="claude" />)

    fireEvent.click(screen.getByRole("button", { name: "Restore from backup" }))
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }))

    expect(await screen.findByText("Couldn't restore: The backup is not valid JSON either")).toBeInTheDocument()
  })

  it("offers no restore when the agent named no backup", () => {
    render(<ErrorBanner error={agentConfigInvalidMessage("claude", { path: PATH, backupPath: null }, CLI_TEXT)} agentKind="claude" />)

    expect(screen.getByText("Claude Code can't start: a config file isn't valid JSON.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Restore from backup" })).toBeNull()
  })
})

describe("ErrorBanner for a session that can only go on in the agent's terminal", () => {
  const command = "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude --resume 5b0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d"
  const error = agentTerminalOnlyMessage(
    "This session was started in Code Mode, so it can only be continued in Claude Code in a terminal.",
    command,
    "Failed to resume session: This session was started in Code Mode (experimental), which isn't available because for now it only works in the interactive terminal, so it can't be resumed here.",
  )

  it("opens a terminal in the project running the resume command", () => {
    render(<ErrorBanner error={error} agentKind="claude" terminalAt={{ path: "/repo", dirName: "-repo" }} />)

    expect(screen.getByText("This session was started in Code Mode, so it can only be continued in Claude Code in a terminal.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Open in terminal" }))

    expect(mocks.openProjectTerminal).toHaveBeenCalledWith({ path: "/repo", dirName: "-repo", command })
  })

  it("offers no terminal to a reader who may not open one, or with nowhere to open it", () => {
    mocks.terminal = false
    const { unmount } = render(<ErrorBanner error={error} agentKind="claude" terminalAt={{ path: "/repo" }} />)
    expect(screen.queryByRole("button", { name: "Open in terminal" })).toBeNull()
    unmount()

    mocks.terminal = true
    render(<ErrorBanner error={error} agentKind="claude" />)
    expect(screen.queryByRole("button", { name: "Open in terminal" })).toBeNull()
  })
})
