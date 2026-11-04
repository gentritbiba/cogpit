// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { logAgentFailure } from "../../agents/failureLog"

afterEach(() => vi.restoreAllMocks())

describe("logAgentFailure", () => {
  it("writes one line with the session, agent and classified reason", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    logAgentFailure("turn", { sessionId: "s1", kind: "claude", message: "Invalid API key · Fix external API key\nmore", httpStatus: 401 })
    logAgentFailure("start", { kind: "codex", message: "Codex isn't installed on this computer.\nInstall it from …" })
    logAgentFailure("turn", { sessionId: "s2", kind: "copilot", message: "unexpected status 503 Service Unavailable" })
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      "[agent] turn failed session=s1 agent=claude reason=not_signed_in status=401: Invalid API key · Fix external API key",
      "[agent] start failed session=- agent=codex reason=not_installed: Codex isn't installed on this computer.",
      "[agent] turn failed session=s2 agent=copilot reason=http_status status=503: unexpected status 503 Service Unavailable",
    ])
  })
})
