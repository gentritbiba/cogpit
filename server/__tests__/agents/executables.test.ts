// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ExecutableChoice } from "../../../shared/contracts/agentExecutable"

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  findExecutableOnPath: vi.fn(),
  isExecutableFile: vi.fn(),
  probeCliVersion: vi.fn(),
  findBundledClaude: vi.fn(),
  execFileSync: vi.fn(),
}))
vi.mock("../../config", () => ({ getConfig: mocks.getConfig }))
vi.mock("../../lib/binaryResolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/binaryResolver")>()),
  findExecutableOnPath: mocks.findExecutableOnPath,
  isExecutableFile: mocks.isExecutableFile,
}))
vi.mock("../../lib/cliProcess", () => ({ probeCliVersion: mocks.probeCliVersion, runCli: vi.fn() }))
vi.mock("../../agents/bundledExecutable", () => ({
  findBundledClaude: mocks.findBundledClaude,
  resolveModule: (id: string) => id,
}))
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: mocks.execFileSync,
}))

const INSTALLED = "/fake/bin/claude"
const BUNDLED = "/fake/app/node_modules/sdk/claude"

/** A machine where `onPath` binaries are on PATH, `runnable` paths can start, and `versions` answer. */
function machine({ choice, onPath = {}, bundled, runnable = [], versions = {} }: {
  choice?: ExecutableChoice
  onPath?: Record<string, string>
  bundled?: string
  runnable?: string[]
  versions?: Record<string, string>
}) {
  mocks.getConfig.mockReturnValue(choice ? { claudeDir: "/home/me/.claude", agentExecutable: choice } : null)
  mocks.findExecutableOnPath.mockImplementation((binName: string) => onPath[binName])
  mocks.findBundledClaude.mockReturnValue(bundled)
  mocks.isExecutableFile.mockImplementation((path: string) => runnable.includes(path))
  mocks.probeCliVersion.mockImplementation(async (path: string) => versions[path] ?? null)
}

async function load() {
  return import("../../agents/executables")
}

describe("findLaunchableExecutable", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it("compares versions without blocking, and later spawns use what it found", async () => {
    machine({
      onPath: { claude: INSTALLED },
      bundled: BUNDLED,
      runnable: [INSTALLED, BUNDLED],
      versions: { [INSTALLED]: "2.1.318", [BUNDLED]: "2.1.306" },
    })
    const { findLaunchableExecutable, activeExecutableFor } = await load()

    await expect(findLaunchableExecutable("claude")).resolves.toEqual({ status: "found", path: INSTALLED, source: "path" })
    expect(mocks.probeCliVersion).toHaveBeenCalledWith(INSTALLED, ["--version"])
    expect(mocks.probeCliVersion).toHaveBeenCalledWith(BUNDLED, ["--version"])
    expect(activeExecutableFor("claude")).toBe(INSTALLED)
    expect(mocks.execFileSync).not.toHaveBeenCalled()
  })

  it("keeps the never-downgrade rule of the automatic choice", async () => {
    machine({
      onPath: { claude: INSTALLED },
      bundled: BUNDLED,
      runnable: [INSTALLED, BUNDLED],
      versions: { [INSTALLED]: "2.1.200", [BUNDLED]: "2.1.306" },
    })
    const { findLaunchableExecutable } = await load()

    await expect(findLaunchableExecutable("claude")).resolves.toEqual({ status: "found", path: BUNDLED, source: "bundled" })
  })

  it("reports nothing to start when the automatic choice finds no binary", async () => {
    machine({})
    const { findLaunchableExecutable } = await load()

    await expect(findLaunchableExecutable("claude")).resolves.toEqual({ status: "absent" })
  })

  it("flags a saved custom path that was deleted instead of reporting it installed", async () => {
    machine({ choice: { source: "custom", path: "/opt/old/claude" }, onPath: { claude: INSTALLED }, runnable: [INSTALLED] })
    const { findLaunchableExecutable } = await load()

    await expect(findLaunchableExecutable("claude")).resolves.toEqual({ status: "unlaunchable-choice", path: "/opt/old/claude" })
    expect(mocks.isExecutableFile).toHaveBeenCalledWith("/opt/old/claude")
    expect(mocks.probeCliVersion).not.toHaveBeenCalled()
  })

  it("flags a saved source that no longer exists on this machine", async () => {
    machine({ choice: { source: "path" }, bundled: BUNDLED, runnable: [BUNDLED] })
    const { findLaunchableExecutable } = await load()

    await expect(findLaunchableExecutable("claude")).resolves.toEqual({ status: "unlaunchable-choice", path: null })
  })

  it("finds the other agents on PATH", async () => {
    machine({ onPath: { codex: "/fake/bin/codex" } })
    const { findLaunchableExecutable } = await load()

    await expect(findLaunchableExecutable("codex")).resolves.toEqual({ status: "found", path: "/fake/bin/codex", source: "path" })
    await expect(findLaunchableExecutable("copilot")).resolves.toEqual({ status: "absent" })
  })
})
