import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// We need to mock dirs.PROJECTS_DIR to point at our temp directory
// so tests don't depend on the real filesystem.
// Use a mutable object so updates in beforeEach are visible through the
// captured import reference.
let tmpDir: string
const mockDirs = { PROJECTS_DIR: "", TEAMS_DIR: "", TASKS_DIR: "", CODEX_SESSIONS_DIR: "" }

mock.module("../../lib/dirs", () => ({
  dirs: mockDirs,
}))

// Import after mock setup
import { listSessions, currentSession } from "../../commands/sessions"

/** Helper: create a minimal JSONL session file with user + assistant turns. */
function writeSession(
  dir: string,
  filename: string,
  opts: {
    sessionId?: string
    cwd?: string
    model?: string
    userMessage?: string
    gitBranch?: string
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
        content: [{ type: "text", text: "I can help with that." }],
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

describe("sessions command", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cogpit-sessions-test-"))
    const projectsDir = join(tmpDir, "projects")
    mkdirSync(projectsDir, { recursive: true })
    mockDirs.PROJECTS_DIR = projectsDir
    mockDirs.TEAMS_DIR = join(projectsDir, "..", "teams")
    mockDirs.TASKS_DIR = join(projectsDir, "..", "tasks")
    mockDirs.CODEX_SESSIONS_DIR = join(tmpDir, "codex-sessions")
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── listSessions ──────────────────────────────────────────────────────────

  describe("listSessions", () => {
    it("returns an empty array when no project directories exist", async () => {
      const result = await listSessions({ limit: 5, maxAge: "1d" })
      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBe(0)
    })

    it("returns sessions sorted by mtime descending", async () => {
      const projDir = join(mockDirs.PROJECTS_DIR, "-test-project")
      mkdirSync(projDir, { recursive: true })

      writeSession(projDir, "older-session.jsonl", { userMessage: "first session" })

      // Wait briefly so the second file has a newer mtime
      await new Promise(r => setTimeout(r, 50))
      writeSession(projDir, "newer-session.jsonl", { userMessage: "second session" })

      const result = await listSessions({ limit: 10, maxAge: "1d" })
      expect(result.length).toBe(2)
      expect(result[0].sessionId).toBe("newer-session")
      expect(result[1].sessionId).toBe("older-session")
      // mtime of first result should be >= mtime of second
      expect(result[0].mtime).toBeGreaterThanOrEqual(result[1].mtime)
    })

    it("respects the limit option", async () => {
      const projDir = join(mockDirs.PROJECTS_DIR, "-test-project")
      mkdirSync(projDir, { recursive: true })

      writeSession(projDir, "s1.jsonl")
      writeSession(projDir, "s2.jsonl")
      writeSession(projDir, "s3.jsonl")

      const result = await listSessions({ limit: 2, maxAge: "1d" })
      expect(result.length).toBe(2)
    })

    it("clamps limit to 100 maximum", async () => {
      const projDir = join(mockDirs.PROJECTS_DIR, "-test-project")
      mkdirSync(projDir, { recursive: true })
      writeSession(projDir, "s1.jsonl")

      // Passing limit > 100 should still work (clamped internally)
      const result = await listSessions({ limit: 999, maxAge: "30d" })
      expect(result.length).toBe(1)
    })

    it("filters sessions by cwd", async () => {
      const proj1 = join(mockDirs.PROJECTS_DIR, "-proj-a")
      const proj2 = join(mockDirs.PROJECTS_DIR, "-proj-b")
      mkdirSync(proj1, { recursive: true })
      mkdirSync(proj2, { recursive: true })

      writeSession(proj1, "s1.jsonl", { cwd: "/workspace/a" })
      writeSession(proj2, "s2.jsonl", { cwd: "/workspace/b" })

      const result = await listSessions({ cwd: "/workspace/a", maxAge: "1d" })
      expect(result.length).toBe(1)
      expect(result[0].cwd).toBe("/workspace/a")
    })

    it("filters sessions by maxAge", async () => {
      const projDir = join(mockDirs.PROJECTS_DIR, "-test-project")
      mkdirSync(projDir, { recursive: true })
      writeSession(projDir, "recent.jsonl")

      // "1m" means 1 minute -- a freshly written file should pass
      const result = await listSessions({ maxAge: "1m" })
      expect(result.length).toBe(1)
    })

    it("each session has the expected shape", async () => {
      const projDir = join(mockDirs.PROJECTS_DIR, "-test-project")
      mkdirSync(projDir, { recursive: true })
      writeSession(projDir, "test.jsonl", {
        sessionId: "test-id",
        cwd: "/my/project",
        model: "claude-opus-4-6",
        userMessage: "explain the architecture",
        gitBranch: "feature-branch",
      })

      const result = await listSessions({ limit: 1, maxAge: "1d" })
      expect(result.length).toBe(1)

      const session = result[0]
      expect(session).toHaveProperty("sessionId")
      expect(session).toHaveProperty("timestamp")
      expect(session).toHaveProperty("model")
      expect(session).toHaveProperty("cwd")
      expect(session).toHaveProperty("gitBranch")
      expect(session).toHaveProperty("slug")
      expect(session).toHaveProperty("firstMessage")
      expect(session).toHaveProperty("lastMessage")
      expect(session).toHaveProperty("turnCount")
      expect(session).toHaveProperty("status")
      expect(session).toHaveProperty("mtime")
      expect(typeof session.mtime).toBe("number")
    })

    it("skips the 'memory' directory", async () => {
      const memDir = join(mockDirs.PROJECTS_DIR, "memory")
      mkdirSync(memDir, { recursive: true })
      writeSession(memDir, "should-be-skipped.jsonl")

      const result = await listSessions({ maxAge: "1d" })
      expect(result.length).toBe(0)
    })

    it("discovers sessions across multiple project directories", async () => {
      const proj1 = join(mockDirs.PROJECTS_DIR, "-proj-one")
      const proj2 = join(mockDirs.PROJECTS_DIR, "-proj-two")
      mkdirSync(proj1, { recursive: true })
      mkdirSync(proj2, { recursive: true })

      writeSession(proj1, "s1.jsonl", { cwd: "/proj/one" })
      writeSession(proj2, "s2.jsonl", { cwd: "/proj/two" })

      const result = await listSessions({ maxAge: "1d" })
      expect(result.length).toBe(2)
    })
  })

  // ── currentSession ────────────────────────────────────────────────────────

  describe("currentSession", () => {
    it("returns null for nonexistent path", async () => {
      const result = await currentSession("/nonexistent/path/xyz12345")
      expect(result).toBeNull()
    })

    it("finds the most recent session for a given cwd", async () => {
      // CWD "/test/project" -> dir name "-test-project"
      const projDir = join(mockDirs.PROJECTS_DIR, "-test-project")
      mkdirSync(projDir, { recursive: true })

      writeSession(projDir, "old.jsonl", { userMessage: "old session" })
      await new Promise(r => setTimeout(r, 50))
      writeSession(projDir, "new.jsonl", { userMessage: "new session" })

      const result = await currentSession("/test/project")
      expect(result).not.toBeNull()
      expect(result!.sessionId).toBe("new")
    })

    it("returns null when project dir has no .jsonl files", async () => {
      // CWD "/empty/dir" -> dir name "-empty-dir"
      const projDir = join(mockDirs.PROJECTS_DIR, "-empty-dir")
      mkdirSync(projDir, { recursive: true })
      writeFileSync(join(projDir, "not-a-jsonl.txt"), "random content")

      const result = await currentSession("/empty/dir")
      expect(result).toBeNull()
    })

    it("returns a session with the expected shape", async () => {
      const projDir = join(mockDirs.PROJECTS_DIR, "-my-project")
      mkdirSync(projDir, { recursive: true })
      writeSession(projDir, "abc123.jsonl", {
        sessionId: "abc123",
        cwd: "/my/project",
        model: "claude-opus-4-6",
        userMessage: "what is this project about?",
      })

      const result = await currentSession("/my/project")
      expect(result).not.toBeNull()
      expect(result!.sessionId).toBe("abc123")
      expect(result!).toHaveProperty("timestamp")
      expect(result!).toHaveProperty("model")
      expect(result!).toHaveProperty("cwd")
      expect(result!).toHaveProperty("gitBranch")
      expect(result!).toHaveProperty("slug")
      expect(result!).toHaveProperty("firstMessage")
      expect(result!).toHaveProperty("lastMessage")
      expect(result!).toHaveProperty("turnCount")
      expect(result!).toHaveProperty("status")
      expect(result!).toHaveProperty("mtime")
      expect(typeof result!.mtime).toBe("number")
    })

    it("handles dots in the cwd path", async () => {
      // CWD "/Users/me/.config" -> dir name "-Users-me--config"
      const projDir = join(mockDirs.PROJECTS_DIR, "-Users-me--config")
      mkdirSync(projDir, { recursive: true })
      writeSession(projDir, "dotpath.jsonl", { cwd: "/Users/me/.config" })

      const result = await currentSession("/Users/me/.config")
      expect(result).not.toBeNull()
      expect(result!.sessionId).toBe("dotpath")
    })
  })
})
