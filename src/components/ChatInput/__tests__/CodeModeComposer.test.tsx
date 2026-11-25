import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { CodeModeComposer } from "../CodeModeComposer"
import { setCodeModeEnabled, registerCodeModeRunner } from "@/lib/agents/codeMode"

const SESSION = "5b0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d"
const runner = { ready: true, start: vi.fn(), show: vi.fn(() => true), status: vi.fn(() => null) }
let unregister: (() => void) | null = null

afterEach(() => {
  unregister?.()
  unregister = null
  vi.clearAllMocks()
  cleanup()
})

describe("CodeModeComposer", () => {
  beforeEach(() => setCodeModeEnabled("local", false))

  it("offers no terminal on a server that predates Code Mode", () => {
    setCodeModeEnabled("local", null)
    unregister = registerCodeModeRunner("local", runner)
    render(<CodeModeComposer sessionId={SESSION} agentKind="claude" cwd="/project" running={false} />)

    expect(screen.queryByRole("button")).toBeNull()
  })

  it("points at the terminal running the session", () => {
    unregister = registerCodeModeRunner("local", runner)
    render(<CodeModeComposer sessionId={SESSION} agentKind="claude" cwd="/project" running />)

    expect(screen.getByText(/Claude Code is running this session in the terminal/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Show terminal" }))
    expect(runner.show).toHaveBeenCalledWith(SESSION)
  })

  it("continues a stopped session in a new terminal", () => {
    unregister = registerCodeModeRunner("local", runner)
    render(<CodeModeComposer sessionId={SESSION} agentKind="claude" cwd="/project" running={false} />)

    fireEvent.click(screen.getByRole("button", { name: "Continue in terminal" }))
    expect(runner.start).toHaveBeenCalledWith({ kind: "claude", sessionId: SESSION, resume: true, cwd: "/project" })
  })

  it("says where to continue when no terminal can open here", () => {
    render(<CodeModeComposer sessionId={SESSION} agentKind="claude" cwd="/project" running={false} />)

    expect(screen.getByText(/Continue it from the terminal panel on a computer/)).toBeInTheDocument()
    expect(screen.queryByRole("button")).toBeNull()
  })
})
