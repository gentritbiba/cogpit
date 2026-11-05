import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { AgentCheckView } from "../AgentCheckView"
import { registerSignInRunner } from "@/lib/agents/signIn"
import { BUNDLED_SIGNED_OUT } from "./fixtures"

const check = { agents: [BUNDLED_SIGNED_OUT], checking: false, error: null, recheck: vi.fn() }

describe("AgentCheckView sign-in", () => {
  it("opens the agent's own sign-in in Cogpit's terminal and lets its dialog step aside", () => {
    const runner = vi.fn()
    const unregister = registerSignInRunner(runner)
    const onSignInStarted = vi.fn()
    render(<AgentCheckView check={check} onSignInStarted={onSignInStarted} />)

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

    expect(runner).toHaveBeenCalledExactlyOnceWith({ target: { kind: "claude", instanceId: null }, name: "Sign in to Claude Code" })
    expect(onSignInStarted).toHaveBeenCalledOnce()
    unregister()
  })

  it("offers only the command to copy where there is no terminal, as on the setup screen", () => {
    render(<AgentCheckView check={check} />)
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument()
    expect(screen.getByTitle(BUNDLED_SIGNED_OUT.signIn!.command)).toBeInTheDocument()
  })
})
