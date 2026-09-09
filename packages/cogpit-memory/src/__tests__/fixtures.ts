import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { mock } from "bun:test"

/**
 * A mutable `dirs` stand-in so the stores, which read it lazily, see whatever
 * each test's `beforeEach` points the roots at.
 */
export const mockDirs = {
  PROJECTS_DIR: "",
  TEAMS_DIR: "",
  TASKS_DIR: "",
  CODEX_SESSIONS_DIR: "",
  COPILOT_SESSIONS_DIR: "",
}

export const mockDbPath = { value: "" }

export function installDirsMock(): void {
  mock.module("../lib/dirs", () => ({
    dirs: mockDirs,
    get DEFAULT_DB_PATH() {
      return mockDbPath.value
    },
  }))
}

/** A minimal Claude JSONL transcript with one user + assistant turn. */
export function writeSession(
  dir: string,
  filename: string,
  opts: {
    sessionId?: string
    cwd?: string
    model?: string
    gitBranch?: string
    userMessage?: string
    assistantMessage?: string
  } = {},
): string {
  const filePath = join(dir, filename)
  const lines = [
    JSON.stringify({
      type: "system",
      sessionId: opts.sessionId ?? filename.replace(".jsonl", ""),
      cwd: opts.cwd ?? "/test/project",
      gitBranch: opts.gitBranch ?? "main",
    }),
    JSON.stringify({
      type: "user",
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: opts.userMessage ?? "Hello, world",
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: opts.assistantMessage ?? "I can help with that." }],
        model: opts.model ?? "claude-sonnet-4-20250514",
        id: "msg_test",
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }),
  ]
  writeFileSync(filePath, lines.join("\n"))
  return filePath
}

/** A Copilot session-state directory. `full` adds the metadata and shutdown lines. */
export function writeCopilotSession(
  root: string,
  sessionId: string,
  opts: { cwd?: string; userMessage?: string; full?: boolean } = {},
): string {
  const sessionDir = join(root, sessionId)
  mkdirSync(sessionDir, { recursive: true })
  const cwd = opts.cwd ?? "/workspace/copilot"
  const timestamp = new Date().toISOString()
  const lines = [
    JSON.stringify({
      type: "session.start",
      data: opts.full
        ? {
            sessionId,
            copilotVersion: "1.0.4",
            selectedModel: "gpt-5.4",
            context: { cwd, branch: "main" },
          }
        : { sessionId, context: { cwd } },
      timestamp,
    }),
    JSON.stringify({
      type: "user.message",
      data: { content: opts.userMessage ?? "Help from Copilot" },
      timestamp,
    }),
  ]
  if (opts.full) {
    lines.push(
      JSON.stringify({ type: "assistant.message", data: { content: "Sure" }, timestamp }),
      JSON.stringify({
        type: "session.shutdown",
        data: { shutdownType: "routine", currentModel: "gpt-5.4", modelMetrics: {} },
        timestamp,
      }),
    )
  }
  const filePath = join(sessionDir, "events.jsonl")
  writeFileSync(filePath, lines.join("\n"))
  return filePath
}
