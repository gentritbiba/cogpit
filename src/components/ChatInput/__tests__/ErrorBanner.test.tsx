import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))

import { ErrorBanner } from "../ErrorBanner"
import { agentConfigInvalidMessage } from "../../../../shared/session/agentFailures"

const PATH = "/Users/me/.claude.json"
const BACKUP = "/Users/me/.claude/backups/.claude.json.backup.1763400000000"
const CLI_TEXT = `Configuration error in ${PATH}: JSON Parse error: Property name must be a string literal`

beforeEach(() => {
  mocks.authFetch.mockReset()
})

describe("ErrorBanner for a config file the agent would not start with", () => {
  it("restores the backup once the reader confirms", async () => {
    mocks.authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ path: PATH, backupPath: BACKUP }), { status: 200 }))
    render(<ErrorBanner error={agentConfigInvalidMessage("claude", { path: PATH, backupPath: BACKUP }, CLI_TEXT)} agentKind="claude" />)

    expect(screen.getByText("Claude Code can't start: a config file isn't valid JSON.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Restore from backup" }))
    expect(mocks.authFetch).not.toHaveBeenCalled()
    expect(await screen.findByText(`This replaces ${PATH} with ${BACKUP}. Changes made since that backup are lost.`)).toBeInTheDocument()

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
