// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"

let fixtureRoot: string
let originalCodexHome: string | undefined
let sessionPaths: typeof import("../sessionPaths")
let helpers: typeof import("../helpers")
let pathSafety: typeof import("../pathSafety")

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "cogpit-session-paths-"))
  originalCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = join(fixtureRoot, "codex-home")
  vi.resetModules()

  sessionPaths = await import("../sessionPaths")
  helpers = await import("../helpers")
  pathSafety = await import("../pathSafety")

  sessionPaths.dirs.PROJECTS_DIR = join(fixtureRoot, "claude-projects")
  sessionPaths.dirs.TEAMS_DIR = join(fixtureRoot, "claude-teams")
  sessionPaths.dirs.TASKS_DIR = join(fixtureRoot, "claude-tasks")
  sessionPaths.dirs.UNDO_DIR = join(fixtureRoot, "undo")
  await Promise.all([
    mkdir(sessionPaths.dirs.PROJECTS_DIR, { recursive: true }),
    mkdir(sessionPaths.CODEX_SESSIONS_DIR, { recursive: true }),
  ])
})

afterAll(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  await rm(fixtureRoot, { recursive: true, force: true })
  vi.resetModules()
})

describe("sessionPaths", () => {
  it("keeps helpers compatibility exports on the extracted module identities", () => {
    expect(helpers.dirs).toBe(sessionPaths.dirs)
    expect(helpers.listCodexSessionFiles).toBe(sessionPaths.listCodexSessionFiles)
    expect(helpers.resolveSessionFilePath).toBe(sessionPaths.resolveSessionFilePath)
    expect(helpers.findJsonlPath).toBe(sessionPaths.findJsonlPath)
    expect(helpers.isWithinDir).toBe(pathSafety.isWithinDir)
  })

  it("preserves Codex directory encoding and rollout path formats", () => {
    const cwd = "/tmp/a project/ünicode"
    const encoded = sessionPaths.encodeCodexDirName(cwd)

    expect(encoded).toMatch(/^codex__[A-Za-z0-9_-]+$/)
    expect(sessionPaths.decodeCodexDirName(encoded)).toBe(cwd)
    expect(sessionPaths.decodeCodexDirName("not-codex")).toBeNull()
    expect(sessionPaths.CODEX_HOME_DIR).toBe(resolve(fixtureRoot, "codex-home"))
    expect(sessionPaths.CODEX_SESSIONS_DIR).toBe(join(sessionPaths.CODEX_HOME_DIR, "sessions"))
    expect(sessionPaths.formatCodexRolloutFileName(
      "thread-123",
      new Date(2026, 2, 18, 10, 11, 12),
    )).toBe("2026/03/18/rollout-2026-03-18T10-11-12-thread-123.jsonl")
  })

  it("resolves Claude and Codex files without allowing traversal outside their roots", async () => {
    const codexDirName = sessionPaths.encodeCodexDirName("/work/project")
    const codexFileName = "2026/07/21/rollout-thread.jsonl"
    const claudeProjectDir = join(sessionPaths.dirs.PROJECTS_DIR, "project-a")
    const claudeFilePath = join(claudeProjectDir, "session.jsonl")
    const codexFilePath = join(sessionPaths.CODEX_SESSIONS_DIR, codexFileName)
    await Promise.all([
      mkdir(claudeProjectDir, { recursive: true }),
      mkdir(dirname(codexFilePath), { recursive: true }),
    ])
    await Promise.all([
      writeFile(claudeFilePath, "{}\n"),
      writeFile(codexFilePath, "{}\n"),
    ])

    await expect(sessionPaths.resolveSessionFilePath("project-a", "session.jsonl"))
      .resolves.toBe(claudeFilePath)
    await expect(sessionPaths.resolveSessionFilePath(codexDirName, codexFileName))
      .resolves.toBe(codexFilePath)
    await expect(sessionPaths.resolveSessionFilePath("project-a", "../../outside.jsonl"))
      .resolves.toBeNull()
    await expect(sessionPaths.resolveSessionFilePath(codexDirName, "../../outside.jsonl"))
      .resolves.toBeNull()
  })

  it("keeps Claude resolution inside the requested project", async () => {
    const projectA = join(sessionPaths.dirs.PROJECTS_DIR, "containment-a")
    const projectB = join(sessionPaths.dirs.PROJECTS_DIR, "containment-b")
    const projectBFile = join(projectB, "other.jsonl")
    await Promise.all([
      mkdir(projectA, { recursive: true }),
      mkdir(projectB, { recursive: true }),
    ])
    await writeFile(projectBFile, "{}\n")

    await expect(sessionPaths.resolveSessionFilePath("containment-a", "../containment-b/other.jsonl"))
      .resolves.toBeNull()
    await expect(sessionPaths.resolveSessionFilePath("containment-a/../containment-b", "other.jsonl"))
      .resolves.toBeNull()
    await expect(sessionPaths.resolveSessionFilePath("containment-a\\..\\containment-b", "other.jsonl"))
      .resolves.toBeNull()
  })

  it("rejects session symlinks that canonically escape their requested project", async () => {
    const projectA = join(sessionPaths.dirs.PROJECTS_DIR, "symlink-a")
    const projectB = join(sessionPaths.dirs.PROJECTS_DIR, "symlink-b")
    const internalFile = join(projectA, "internal.jsonl")
    const projectBFile = join(projectB, "other.jsonl")
    const outsideFile = join(fixtureRoot, "outside.jsonl")
    const codexOutsideLink = join(sessionPaths.CODEX_SESSIONS_DIR, "outside.jsonl")
    await Promise.all([
      mkdir(projectA, { recursive: true }),
      mkdir(projectB, { recursive: true }),
    ])
    await Promise.all([
      writeFile(internalFile, "{}\n"),
      writeFile(projectBFile, "{}\n"),
      writeFile(outsideFile, "{}\n"),
    ])
    await Promise.all([
      symlink(internalFile, join(projectA, "internal-link.jsonl")),
      symlink(projectBFile, join(projectA, "other-project.jsonl")),
      symlink(outsideFile, join(projectA, "outside.jsonl")),
      symlink(outsideFile, codexOutsideLink),
    ])

    await expect(sessionPaths.resolveSessionFilePath("symlink-a", "internal-link.jsonl"))
      .resolves.toBe(join(projectA, "internal-link.jsonl"))
    await expect(sessionPaths.resolveSessionFilePath("symlink-a", "other-project.jsonl"))
      .resolves.toBeNull()
    await expect(sessionPaths.resolveSessionFilePath("symlink-a", "outside.jsonl"))
      .resolves.toBeNull()
    await expect(sessionPaths.resolveSessionFilePath(
      sessionPaths.encodeCodexDirName("/work/project"),
      "outside.jsonl",
    )).resolves.toBeNull()
  })

  it("rejects a requested project directory that canonically escapes the projects root", async () => {
    const outsideProject = join(fixtureRoot, "outside-project")
    const outsideFile = join(outsideProject, "session.jsonl")
    const projectAlias = join(sessionPaths.dirs.PROJECTS_DIR, "project-alias")
    await mkdir(outsideProject, { recursive: true })
    await writeFile(outsideFile, "{}\n")
    await symlink(outsideProject, projectAlias, "dir")

    await expect(sessionPaths.resolveSessionFilePath("project-alias", "session.jsonl"))
      .resolves.toBeNull()
  })

  it("discovers nested Codex JSONL files with stable relative names", async () => {
    const relativeName = "2026/07/21/rollout-discovery.jsonl"
    const filePath = join(sessionPaths.CODEX_SESSIONS_DIR, relativeName)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, '{"type":"session_meta"}\n')
    await writeFile(join(dirname(filePath), "ignored.txt"), "ignore me")

    const files = await sessionPaths.listCodexSessionFiles()
    const discovered = files.find((file) => file.filePath === filePath)

    expect(discovered).toMatchObject({
      filePath,
      fileName: relativeName,
      size: 24,
    })
    expect(files.some((file) => file.fileName.endsWith("ignored.txt"))).toBe(false)
  })

  it("searches Claude first and falls back to Codex session IDs", async () => {
    const claudeProject = join(sessionPaths.dirs.PROJECTS_DIR, "project-b")
    const claudePath = join(claudeProject, "shared-id.jsonl")
    const codexSharedPath = join(
      sessionPaths.CODEX_SESSIONS_DIR,
      "2026/07/21/rollout-shared-id.jsonl",
    )
    const codexOnlyPath = join(
      sessionPaths.CODEX_SESSIONS_DIR,
      "2026/07/21/rollout-codex-only.jsonl",
    )
    await mkdir(claudeProject, { recursive: true })
    await Promise.all([
      writeFile(claudePath, "{}\n"),
      writeFile(codexSharedPath, "{}\n"),
      writeFile(codexOnlyPath, "{}\n"),
    ])

    await expect(sessionPaths.findJsonlPath("shared-id")).resolves.toBe(claudePath)
    await expect(sessionPaths.findJsonlPath("codex-only")).resolves.toBe(codexOnlyPath)
    await expect(sessionPaths.findJsonlPath("missing-id")).resolves.toBeNull()
  })

  it("finds the newest untracked Codex session for the requested working directory", async () => {
    const requestedCwd = "/work/requested"
    const matchingPath = join(
      sessionPaths.CODEX_SESSIONS_DIR,
      "2026/07/21/rollout-matching-thread.jsonl",
    )
    const otherPath = join(
      sessionPaths.CODEX_SESSIONS_DIR,
      "2026/07/21/rollout-other-thread.jsonl",
    )
    const startedAt = Date.now()
    await Promise.all([
      writeFile(matchingPath, JSON.stringify({
        type: "session_meta",
        payload: { id: "matching-thread", cwd: requestedCwd },
      }) + "\n"),
      writeFile(otherPath, JSON.stringify({
        type: "session_meta",
        payload: { id: "other-thread", cwd: "/work/other" },
      }) + "\n"),
    ])

    await expect(sessionPaths.findNewestCodexSessionForCwd(
      requestedCwd,
      new Set<string>(),
      startedAt,
    )).resolves.toEqual({
      filePath: matchingPath,
      fileName: "2026/07/21/rollout-matching-thread.jsonl",
      sessionId: "matching-thread",
    })
    await expect(sessionPaths.findNewestCodexSessionForCwd(
      requestedCwd,
      new Set([matchingPath]),
      startedAt,
    )).resolves.toBeNull()
  })

  it("derives provider kind from the extracted Codex sessions root", () => {
    const codexPath = [sessionPaths.CODEX_SESSIONS_DIR, "2026", "07", "21", "thread.jsonl"].join(sep)
    const siblingPath = [sessionPaths.CODEX_HOME_DIR, "other-sessions", "thread.jsonl"].join(sep)
    expect(sessionPaths.isCodexFilePath(codexPath)).toBe(true)
    expect(sessionPaths.isCodexFilePath(sessionPaths.CODEX_SESSIONS_DIR)).toBe(false)
    expect(sessionPaths.isCodexFilePath(`${sessionPaths.CODEX_SESSIONS_DIR}${sep}.`)).toBe(false)
    expect(sessionPaths.isCodexFilePath(siblingPath)).toBe(false)
    expect(sessionPaths.isCodexFilePath(`${sessionPaths.CODEX_SESSIONS_DIR}-archive${sep}thread.jsonl`)).toBe(false)
    expect(sessionPaths.getAgentKindFromSessionPath(codexPath)).toBe("codex")
    expect(sessionPaths.getAgentKindFromSessionPath(join(fixtureRoot, "claude.jsonl"))).toBe("claude")
    expect(sessionPaths.getAgentKindFromSessionPath(null)).toBe("claude")
  })
})
