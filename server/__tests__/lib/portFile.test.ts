// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "cogpit-portfile-"))
const portFile = join(dir, ".cogpit", "port")

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, homedir: () => dir }
})

const { PORT_FILE, removePortFile, writePortFile } = await import("../../lib/portFile")

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  rmSync(join(dir, ".cogpit"), { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("portFile", () => {
  it("resolves under the home directory", () => {
    expect(PORT_FILE).toBe(portFile)
  })

  it("creates the directory and writes the port", () => {
    writePortFile(19384)
    expect(readFileSync(portFile, "utf8").trim()).toBe("19384")
  })

  // Windows has no POSIX modes — chmod only toggles the read-only bit there, so
  // a real file can never report 0600.
  it.skipIf(process.platform === "win32")(
    "writes owner-only, since the file steers where hook payloads are POSTed",
    () => {
      writePortFile(19384)
      expect(statSync(portFile).mode & 0o777).toBe(0o600)
    },
  )

  it("overwrites a stale port rather than appending", () => {
    writePortFile(19384)
    writePortFile(52001)
    expect(readFileSync(portFile, "utf8").trim()).toBe("52001")
  })

  it("removes the file so a dead port cannot receive session text", () => {
    writePortFile(19384)
    removePortFile()
    expect(existsSync(portFile)).toBe(false)
  })

  it("is safe to remove when already absent", () => {
    expect(() => removePortFile()).not.toThrow()
  })

  it("reports rather than swallows a write failure", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    // A directory sitting exactly where the file belongs makes the write EISDIR.
    mkdirSync(portFile, { recursive: true })

    expect(() => writePortFile(19384)).not.toThrow()
    expect(spy).toHaveBeenCalled()
  })
})
