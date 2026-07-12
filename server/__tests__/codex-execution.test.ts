// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { CodexAppServerError, type CodexThread } from "../codex-app-server"
import {
  buildCodexAccessSettings,
  buildCodexUserInput,
  continueCodexExecution,
  getCodexThreadIdentity,
  isCodexAppServerUnavailable,
  startCodexExecution,
  type CodexExecutionClient,
} from "../lib/codexExecution"

function thread(overrides: Record<string, unknown> = {}): CodexThread {
  return { id: "thread-1", turns: [], ...overrides }
}

function client(overrides: Partial<CodexExecutionClient> = {}): CodexExecutionClient {
  return {
    start: vi.fn().mockResolvedValue({}),
    startThread: vi.fn().mockResolvedValue({ thread: thread() }),
    resumeThread: vi.fn().mockResolvedValue({ thread: thread() }),
    startTurn: vi.fn().mockResolvedValue({ turn: { id: "turn-new" } }),
    steerTurn: vi.fn().mockResolvedValue({ turnId: "turn-active" }),
    interruptTurn: vi.fn().mockResolvedValue({}),
    getActiveTurnId: vi.fn(),
    call: vi.fn().mockResolvedValue({}),
    ...overrides,
  }
}

describe("Codex execution mappings", () => {
  it("maps workspace, plan, and explicit full access safely", () => {
    expect(buildCodexAccessSettings()).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    })
    expect(buildCodexAccessSettings({ mode: "plan" })).toEqual({
      approvalPolicy: "never",
      sandbox: "read-only",
    })
    expect(buildCodexAccessSettings({ mode: "bypassPermissions" })).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    })
  })

  it("converts text and images into native UserInput", () => {
    expect(buildCodexUserInput("Inspect this", [
      { data: "YWJj", mediaType: "image/png" },
      { data: "data:image/jpeg;base64,ZGVm", mediaType: "image/jpeg" },
    ])).toEqual([
      { type: "text", text: "Inspect this", text_elements: [] },
      { type: "image", url: "data:image/png;base64,YWJj" },
      { type: "image", url: "data:image/jpeg;base64,ZGVm" },
    ])
  })

  it("starts a configured thread then accepts its first turn", async () => {
    const runtime = client()
    await startCodexExecution(runtime, {
      cwd: "/work/project",
      message: "Build it",
      model: "gpt-5.6-sol",
      effort: "ultra",
      fastMode: true,
    })

    expect(runtime.startThread).toHaveBeenCalledWith({
      cwd: "/work/project",
      model: "gpt-5.6-sol",
      serviceTier: "priority",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    })
    expect(runtime.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-1",
      input: [{ type: "text", text: "Build it", text_elements: [] }],
      cwd: "/work/project",
      model: "gpt-5.6-sol",
      effort: "ultra",
      serviceTier: "priority",
      approvalPolicy: "on-request",
      sandboxPolicy: expect.objectContaining({ type: "workspaceWrite" }),
    }))
  })

  it("resumes an idle thread and starts a new turn", async () => {
    const runtime = client()
    const result = await continueCodexExecution(
      runtime,
      "thread-1",
      "/safe/rollout.jsonl",
      {
        cwd: "/work/project",
        message: "Continue",
        permissions: { mode: "plan" },
        fastMode: false,
      },
    )

    expect(runtime.resumeThread).toHaveBeenCalledWith("thread-1", {
      path: "/safe/rollout.jsonl",
      cwd: "/work/project",
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceTier: null,
    })
    expect(runtime.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-1",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      serviceTier: null,
    }))
    expect(runtime.steerTurn).not.toHaveBeenCalled()
    expect(result).toEqual({ action: "started", threadId: "thread-1", turnId: "turn-new" })
  })

  it("steers a known active turn without resuming", async () => {
    const runtime = client({
      getActiveTurnId: vi.fn(() => "turn-active"),
    })
    const result = await continueCodexExecution(runtime, "thread-1", null, {
      cwd: "/work/project",
      message: "Focus on tests",
    })

    expect(runtime.resumeThread).not.toHaveBeenCalled()
    expect(runtime.call).not.toHaveBeenCalled()
    expect(runtime.steerTurn).toHaveBeenCalledWith(
      "thread-1",
      [{ type: "text", text: "Focus on tests", text_elements: [] }],
      "turn-active",
    )
    expect(result.action).toBe("steered")
  })

  it("steers an active turn discovered while resuming", async () => {
    const runtime = client({
      resumeThread: vi.fn().mockResolvedValue({
        thread: thread({ turns: [{ id: "turn-resumed", status: "inProgress" }] }),
      }),
    })
    await continueCodexExecution(runtime, "thread-1", null, {
      cwd: "/work/project",
      message: "Add this constraint",
    })

    expect(runtime.startTurn).not.toHaveBeenCalled()
    expect(runtime.call).not.toHaveBeenCalled()
    expect(runtime.steerTurn).toHaveBeenCalledWith(
      "thread-1",
      expect.any(Array),
      "turn-resumed",
    )
  })

  it("accepts only nested rollout paths inside the Codex sessions root", () => {
    expect(getCodexThreadIdentity(thread({
      path: "/codex/sessions/2026/07/12/rollout-thread-1.jsonl",
    }), "/codex/sessions")).toEqual({
      sessionId: "thread-1",
      fileName: "2026/07/12/rollout-thread-1.jsonl",
      filePath: "/codex/sessions/2026/07/12/rollout-thread-1.jsonl",
    })
    expect(getCodexThreadIdentity(thread({
      path: "/codex/outside/rollout-thread-1.jsonl",
    }), "/codex/sessions")).toBeNull()
    expect(getCodexThreadIdentity(thread({ path: null }), "/codex/sessions")).toBeNull()
  })

  it("does not treat an ambiguous mutating RPC timeout as a legacy fallback", () => {
    expect(isCodexAppServerUnavailable(
      new CodexAppServerError("Codex app-server turn/start timed out after 30000ms"),
    )).toBe(false)
  })
})
