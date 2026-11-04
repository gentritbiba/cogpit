// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openStartupLog } from "../startupLog"

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cogpit-startup-log-"))
  dirs.push(dir)
  return dir
}

describe("openStartupLog", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it("starts each launch with a fresh file and stops writing once closed", () => {
    const dir = join(tempDir(), "logs")
    const previous = openStartupLog(dir)
    previous.write("old launch\n")
    previous.close()

    const log = openStartupLog(dir)
    log.write("[server-worker] starting\n")
    log.write(Buffer.from("Error: listen EADDRINUSE\n"))
    log.close()
    log.write("after ready\n")

    expect(log.path).toBe(join(dir, "startup.log"))
    expect(readFileSync(log.path!, "utf8")).toBe("[server-worker] starting\nError: listen EADDRINUSE\n")
  })

  it("has no path when the log directory cannot be created", () => {
    const blocker = join(tempDir(), "file")
    writeFileSync(blocker, "")

    const log = openStartupLog(join(blocker, "logs"))
    log.write("ignored")
    log.close()

    expect(log.path).toBeNull()
  })
})
