import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ElicitationPrompt } from "../ElicitationPrompt"
import type { MissionControlElicitation } from "../../../../shared/contracts/agentPrompts"

function formRequest(
  fields: MissionControlElicitation["fields"],
): MissionControlElicitation {
  return {
    sessionId: "session-1",
    requestId: "req-1",
    serverName: "github",
    message: "Enter your access token",
    mode: "form",
    askedAt: 0,
    fields,
  }
}

function renderPrompt(request: MissionControlElicitation, onAnswer = vi.fn()) {
  render(<ElicitationPrompt request={request} responding={false} onAnswer={onAnswer} />)
  return onAnswer
}

describe("ElicitationPrompt", () => {
  it("sends typed form values as an accept", async () => {
    const user = userEvent.setup()
    const onAnswer = renderPrompt(formRequest([
      { name: "token", label: "Token", type: "string", required: true },
      { name: "port", label: "Port", type: "integer", required: false },
    ]))

    await user.type(screen.getByLabelText("Token"), "ghp_x")
    await user.type(screen.getByLabelText("Port"), "8080")
    await user.click(screen.getByRole("button", { name: "Send" }))

    expect(onAnswer).toHaveBeenCalledWith("req-1", {
      action: "accept",
      content: { token: "ghp_x", port: 8080 },
    })
  })

  it("keeps Send disabled until every required field is filled", async () => {
    const user = userEvent.setup()
    renderPrompt(formRequest([
      { name: "token", label: "Token", type: "string", required: true },
    ]))

    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
    await user.type(screen.getByLabelText("Token"), "x")
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
  })

  it("seeds checkbox and choice fields from their schema defaults", async () => {
    const user = userEvent.setup()
    const onAnswer = renderPrompt(formRequest([
      { name: "remember", label: "Remember me", type: "boolean", required: false, defaultValue: true },
      {
        name: "scope",
        label: "Scope",
        type: "enum",
        required: true,
        defaultValue: "repo",
        options: [{ value: "repo", label: "Repo" }, { value: "gist", label: "Gist" }],
      },
    ]))

    await user.click(screen.getByRole("button", { name: "Send" }))

    expect(onAnswer).toHaveBeenCalledWith("req-1", {
      action: "accept",
      content: { remember: true, scope: "repo" },
    })
  })

  it("declines without sending any content", async () => {
    const user = userEvent.setup()
    const onAnswer = renderPrompt(formRequest([
      { name: "token", label: "Token", type: "string", required: true },
    ]))

    await user.click(screen.getByRole("button", { name: "Decline" }))

    expect(onAnswer).toHaveBeenCalledWith("req-1", { action: "decline" })
  })

  describe("url mode", () => {
    const urlRequest: MissionControlElicitation = {
      sessionId: "session-1",
      requestId: "req-url",
      serverName: "linear",
      message: "Authorize Cogpit in your browser",
      mode: "url",
      url: "https://linear.app/oauth/authorize",
      askedAt: 0,
      fields: [],
    }

    beforeEach(() => {
      vi.stubGlobal("open", vi.fn())
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it("opens the link and accepts so the server can continue", async () => {
      const user = userEvent.setup()
      const onAnswer = renderPrompt(urlRequest)

      await user.click(screen.getByRole("button", { name: "Open link" }))

      expect(window.open).toHaveBeenCalledWith(
        "https://linear.app/oauth/authorize",
        "_blank",
        "noopener,noreferrer",
      )
      expect(onAnswer).toHaveBeenCalledWith("req-url", { action: "accept" })
    })

    it("shows no form fields", () => {
      renderPrompt(urlRequest)
      expect(screen.queryByRole("textbox")).toBeNull()
    })
  })
})
