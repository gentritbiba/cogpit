// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { listProjectTaskOutputs, resolveTaskOutput } from "../../agents/taskOutput"

// Windows has no /tmp, so task output lives under %TEMP% there.
const TEMP_ROOT = process.platform === "win32" ? tmpdir() : "/tmp"

const SESSION = "0f5a3c1e-2b4d-4e6f-8a9b-1c2d3e4f5a6b"
const OTHER_SESSION = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d"
const PROJECT = "-work-project"

/** Windows only permits symlink creation under Developer Mode or elevation. */
const canCreateSymlinks = await (async () => {
  const probeDir = await mkdtemp(join(TEMP_ROOT, "cogpit-symlink-probe-"))
  try {
    await symlink(probeDir, join(probeDir, "link"), "dir")
    return true
  } catch {
    return false
  } finally {
    await rm(probeDir, { recursive: true, force: true })
  }
})()

describe("resolveTaskOutput", () => {
  let namespaceRoot: string
  let outsideRoot: string
  let tasksDir: string

  beforeEach(async () => {
    namespaceRoot = await mkdtemp(join(TEMP_ROOT, "claude-cogpit-output-"))
    outsideRoot = await mkdtemp(join(TEMP_ROOT, "cogpit-output-outside-"))
    tasksDir = join(namespaceRoot, PROJECT, SESSION, "tasks")
    await mkdir(tasksDir, { recursive: true })
  })

  afterEach(async () => {
    await Promise.all([
      rm(namespaceRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ])
  })

  it("places existing and not-yet-created output under the session whose task directory holds it", async () => {
    const existing = join(tasksDir, "task.output")
    await writeFile(existing, "ready")

    await expect(resolveTaskOutput(existing)).resolves.toEqual({ path: await realpath(existing), sessionId: SESSION })
    await expect(resolveTaskOutput(join(tasksDir, "future.output"))).resolves.toEqual({
      path: join(await realpath(tasksDir), "future.output"),
      sessionId: SESSION,
    })
  })

  it("names the session in lower case", async () => {
    const upperTasks = join(namespaceRoot, PROJECT, OTHER_SESSION.toUpperCase(), "tasks")
    await mkdir(upperTasks, { recursive: true })
    await expect(resolveTaskOutput(join(upperTasks, "task.output"))).resolves.toMatchObject({ sessionId: OTHER_SESSION })
  })

  it("places output elsewhere in a claude-* temp tree under no session", async () => {
    const sessionDir = join(namespaceRoot, PROJECT, SESSION)
    for (const path of [
      join(sessionDir, "notes.output"),
      join(sessionDir, "tasks"),
      join(namespaceRoot, PROJECT, "tasks", "task.output"),
      join(namespaceRoot, PROJECT, "not-a-session", "tasks", "task.output"),
      join(namespaceRoot, "task.output"),
    ]) {
      await expect(resolveTaskOutput(path), path).resolves.toMatchObject({ sessionId: null })
    }
  })

  it("refuses paths outside a claude-* temp tree", async () => {
    for (const path of [
      join(outsideRoot, PROJECT, SESSION, "tasks", "task.output"),
      join(TEMP_ROOT, "claude-", PROJECT, SESSION, "tasks", "task.output"),
      namespaceRoot,
      join(tasksDir, "..", "..", "..", "..", "etc", "passwd"),
    ]) {
      await expect(resolveTaskOutput(path), path).resolves.toBeNull()
    }
  })

  it.skipIf(!canCreateSymlinks)(
    "rejects file and directory symlinks that escape the temp tree",
    async () => {
      const outsideFile = join(outsideRoot, "secret.txt")
      await writeFile(outsideFile, "secret")

      const fileLink = join(tasksDir, "file-link.output")
      const directoryLink = join(tasksDir, "directory-link")
      await Promise.all([
        symlink(outsideFile, fileLink, "file"),
        symlink(outsideRoot, directoryLink, "dir"),
      ])

      await expect(resolveTaskOutput(fileLink)).resolves.toBeNull()
      await expect(resolveTaskOutput(join(directoryLink, "secret.txt"))).resolves.toBeNull()
    },
  )

  it.skipIf(!canCreateSymlinks)(
    "places a link into another session's task directory under that session",
    async () => {
      const otherTasks = join(namespaceRoot, PROJECT, OTHER_SESSION, "tasks")
      await mkdir(otherTasks, { recursive: true })
      await writeFile(join(otherTasks, "task.output"), "theirs")
      const link = join(tasksDir, "borrowed.output")
      await symlink(join(otherTasks, "task.output"), link, "file")

      await expect(resolveTaskOutput(link)).resolves.toMatchObject({ sessionId: OTHER_SESSION })
    },
  )

  it.skipIf(!canCreateSymlinks)(
    "rejects broken symlinks instead of treating them as future output files",
    async () => {
      const brokenLink = join(tasksDir, "broken.output")
      await symlink(join(outsideRoot, "missing.output"), brokenLink, "file")

      await expect(resolveTaskOutput(brokenLink)).resolves.toBeNull()
    },
  )
})

describe("listProjectTaskOutputs", () => {
  // A uid no real account has, so the listing reads a tree this test owns.
  const UID = 987_654_321
  const CWD = "/work/my_app.v2"
  const PROJECT_DIR = "-work-my-app-v2"
  const originalGetuid = Object.getOwnPropertyDescriptor(process, "getuid")
  let projectRoot: string

  beforeEach(async () => {
    Object.defineProperty(process, "getuid", { configurable: true, value: () => UID })
    projectRoot = join(await realpath(TEMP_ROOT), `claude-${UID}`, PROJECT_DIR)
    await mkdir(projectRoot, { recursive: true })
  })

  afterEach(async () => {
    if (originalGetuid) Object.defineProperty(process, "getuid", originalGetuid)
    else Reflect.deleteProperty(process, "getuid")
    await rm(join(projectRoot, ".."), { recursive: true, force: true })
  })

  async function writeOutput(session: string, fileName: string): Promise<string> {
    const tasksDir = join(projectRoot, session, "tasks")
    await mkdir(tasksDir, { recursive: true })
    await writeFile(join(tasksDir, fileName), "port 3000")
    return join(tasksDir, fileName)
  }

  it("lists each session's task output under the project, with the session that owns it", async () => {
    const mine = await writeOutput(SESSION, "b1.output")
    const theirs = await writeOutput(OTHER_SESSION.toUpperCase(), "b2.output")
    await writeOutput(SESSION, "notes.txt")

    const listed = await listProjectTaskOutputs(CWD)

    expect(listed.sort((a, b) => a.fileName.localeCompare(b.fileName))).toEqual([
      { sessionId: SESSION, fileName: "b1.output", path: mine, isSymbolicLink: false },
      { sessionId: OTHER_SESSION, fileName: "b2.output", path: theirs, isSymbolicLink: false },
    ])
  })

  it("lists nothing outside a session's task directory", async () => {
    await writeOutput("not-a-session", "b1.output")
    await mkdir(join(projectRoot, "tasks"), { recursive: true })
    await writeFile(join(projectRoot, "tasks", "legacy.output"), "port 3000")

    await expect(listProjectTaskOutputs(CWD)).resolves.toEqual([])
  })

  it("lists nothing for a project with no task output", async () => {
    await expect(listProjectTaskOutputs("/work/elsewhere")).resolves.toEqual([])
  })

  it.skipIf(!canCreateSymlinks)("flags a linked output and skips a linked session directory", async () => {
    const target = await writeOutput(OTHER_SESSION, "b2.output")
    await writeOutput(SESSION, "b1.output")
    await symlink(target, join(projectRoot, SESSION, "tasks", "agent.output"), "file")
    const elsewhere = await mkdtemp(join(TEMP_ROOT, "cogpit-output-elsewhere-"))
    await mkdir(join(elsewhere, "tasks"))
    await writeFile(join(elsewhere, "tasks", "b3.output"), "port 4000")
    const linkedSession = "11111111-2222-4333-8444-555555555555"
    await symlink(elsewhere, join(projectRoot, linkedSession), "dir")

    try {
      const listed = await listProjectTaskOutputs(CWD)
      expect(listed.find((output) => output.fileName === "agent.output")).toMatchObject({ sessionId: SESSION, isSymbolicLink: true })
      expect(listed.some((output) => output.sessionId === linkedSession)).toBe(false)
    } finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it.skipIf(!canCreateSymlinks)("skips a session whose task directory is a link to another's", async () => {
    await writeOutput(OTHER_SESSION, "b2.output")
    await mkdir(join(projectRoot, SESSION))
    await symlink(join(projectRoot, OTHER_SESSION, "tasks"), join(projectRoot, SESSION, "tasks"), "dir")

    const listed = await listProjectTaskOutputs(CWD)

    expect(listed.map((output) => output.sessionId)).toEqual([OTHER_SESSION])
  })
})
