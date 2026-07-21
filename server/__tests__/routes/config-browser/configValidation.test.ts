// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  isAllowedConfigPath,
  isSafeConfigName,
  isUserOwned,
  resolveConfigBrowserPath,
} from "../../../routes/config-browser/configValidation"

describe("config-browser path validation", () => {
  let fixtureRoot: string
  let projectDir: string
  let claudeDir: string
  let agentsDir: string
  let outsideDir: string

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "cogpit-config-paths-"))
    projectDir = join(fixtureRoot, "project")
    claudeDir = join(projectDir, ".claude")
    agentsDir = join(claudeDir, "agents")
    outsideDir = join(fixtureRoot, "outside")
    await Promise.all([
      mkdir(agentsDir, { recursive: true }),
      mkdir(outsideDir, { recursive: true }),
    ])
  })

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true })
  })

  it("accepts real files inside .claude and project-root CLAUDE.md", async () => {
    const agentPath = join(agentsDir, "reviewer.md")
    const projectInstructions = join(projectDir, "CLAUDE.md")
    await Promise.all([
      writeFile(agentPath, "agent", "utf-8"),
      writeFile(projectInstructions, "instructions", "utf-8"),
    ])

    expect(isAllowedConfigPath(agentPath)).toBe(true)
    expect(isUserOwned(agentPath)).toBe(true)
    await expect(resolveConfigBrowserPath(agentPath, { writable: true })).resolves.toEqual({
      resolvedPath: agentPath,
      canonicalPath: await realpath(agentPath),
    })
    await expect(resolveConfigBrowserPath(projectInstructions, { writable: true })).resolves.toEqual({
      resolvedPath: projectInstructions,
      canonicalPath: await realpath(projectInstructions),
    })
  })

  it("accepts a missing destination only while it remains inside .claude", async () => {
    const safeMissingPath = join(agentsDir, "new-agent.md")
    const escapedPath = join(agentsDir, "..", "..", "escaped.md")

    await expect(resolveConfigBrowserPath(safeMissingPath, {
      allowMissing: true,
      writable: true,
    })).resolves.toMatchObject({ resolvedPath: safeMissingPath })
    expect(isAllowedConfigPath(escapedPath)).toBe(false)
    await expect(resolveConfigBrowserPath(escapedPath, {
      allowMissing: true,
      writable: true,
    })).resolves.toBeNull()
  })

  it("rejects a file symlink that escapes its .claude root", async () => {
    const outsideFile = join(outsideDir, "outside.md")
    const linkPath = join(agentsDir, "linked.md")
    await writeFile(outsideFile, "outside", "utf-8")
    await symlink(outsideFile, linkPath, process.platform === "win32" ? "file" : undefined)

    await expect(resolveConfigBrowserPath(linkPath)).resolves.toBeNull()
    await expect(resolveConfigBrowserPath(linkPath, { writable: true })).resolves.toBeNull()
  })

  it("rejects a missing child beneath a directory symlink that escapes", async () => {
    const linkedDirectory = join(claudeDir, "linked-agents")
    await symlink(outsideDir, linkedDirectory, process.platform === "win32" ? "junction" : undefined)

    await expect(resolveConfigBrowserPath(join(linkedDirectory, "escape.md"), {
      allowMissing: true,
      writable: true,
    })).resolves.toBeNull()
  })

  it("does not let a nested .claude symlink redefine the containment root", async () => {
    const nestedParent = join(agentsDir, "nested")
    const nestedClaudeDirectory = join(nestedParent, ".claude")
    await mkdir(nestedParent)
    await symlink(
      outsideDir,
      nestedClaudeDirectory,
      process.platform === "win32" ? "junction" : undefined,
    )

    await expect(resolveConfigBrowserPath(join(nestedClaudeDirectory, "escaped.md"), {
      allowMissing: true,
      writable: true,
    })).resolves.toBeNull()
  })

  it("allows an in-root symlink while returning its canonical target", async () => {
    const target = join(agentsDir, "target.md")
    const linkPath = join(agentsDir, "alias.md")
    await writeFile(target, "target", "utf-8")
    await symlink(target, linkPath, process.platform === "win32" ? "file" : undefined)

    await expect(resolveConfigBrowserPath(linkPath, { writable: true })).resolves.toEqual({
      resolvedPath: linkPath,
      canonicalPath: await realpath(target),
    })
  })

  it("rejects a project CLAUDE.md symlink redirected elsewhere", async () => {
    const outsideFile = join(outsideDir, "instructions.md")
    const projectInstructions = join(projectDir, "CLAUDE.md")
    await writeFile(outsideFile, "outside", "utf-8")
    await symlink(outsideFile, projectInstructions, process.platform === "win32" ? "file" : undefined)

    await expect(resolveConfigBrowserPath(projectInstructions)).resolves.toBeNull()
  })

  it("treats plugin cache paths as read-only, including canonical symlink targets", async () => {
    const cacheDir = join(claudeDir, "plugins", "cache", "plugin")
    const cachedFile = join(cacheDir, "SKILL.md")
    const linkPath = join(agentsDir, "cached-skill.md")
    await mkdir(cacheDir, { recursive: true })
    await writeFile(cachedFile, "cached", "utf-8")
    await symlink(cachedFile, linkPath, process.platform === "win32" ? "file" : undefined)

    expect(isUserOwned(cachedFile)).toBe(false)
    await expect(resolveConfigBrowserPath(cachedFile)).resolves.not.toBeNull()
    await expect(resolveConfigBrowserPath(cachedFile, { writable: true })).resolves.toBeNull()
    await expect(resolveConfigBrowserPath(linkPath, { writable: true })).resolves.toBeNull()
  })

  it.each([
    "..",
    "../escape",
    "nested/escape",
    "nested\\escape",
    "/absolute",
    "C:\\absolute",
    "\\\\server\\share",
  ])("rejects unsafe portable leaf name %j", (name) => {
    expect(isSafeConfigName(name)).toBe(false)
  })

  it.each(["agent", "agent.v2", "..agent", "review notes"])(
    "accepts safe portable leaf name %j",
    (name) => {
      expect(isSafeConfigName(name)).toBe(true)
    },
  )
})
