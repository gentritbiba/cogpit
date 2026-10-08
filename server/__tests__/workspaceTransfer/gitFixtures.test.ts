// @vitest-environment node
import { rm, stat } from "node:fs/promises"
import { expect, it, vi } from "vitest"
import { cleanupTempDirs, tempDir } from "./gitFixtures"

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

it("removes nested fixtures before their parent and retains paths after failed cleanup", async () => {
  const parent = await tempDir("cogpit-cleanup-parent-")
  const originalEnv = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR }
  let child: string
  try {
    process.env.TEMP = parent
    process.env.TMP = parent
    process.env.TMPDIR = parent
    child = await tempDir("cogpit-cleanup-child-")
  } finally {
    for (const name of ["TEMP", "TMP", "TMPDIR"] as const) {
      if (originalEnv[name] === undefined) delete process.env[name]
      else process.env[name] = originalEnv[name]
    }
  }
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  try {
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error("Directory locked"), { code: "EPERM" }))
    await expect(cleanupTempDirs()).rejects.toMatchObject({ code: "EPERM" })
    expect(rm).toHaveBeenCalledWith(child, { recursive: true, force: true })
    await cleanupTempDirs()
    await expect(stat(child)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(stat(parent)).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    await actual.rm(parent, { recursive: true, force: true })
  }
})
