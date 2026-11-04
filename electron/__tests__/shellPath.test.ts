// @vitest-environment node
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { loginShellPath } from "../shellPath"

const dir = mkdtempSync(join(tmpdir(), "cogpit-shell-path-"))

/** A stand-in login shell: a script that ignores its -ilc arguments. */
function fakeShell(name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

describe.skipIf(process.platform === "win32")("loginShellPath", () => {
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("returns the PATH the shell prints", async () => {
    await expect(loginShellPath(fakeShell("ok", "printf '/opt/bin:/usr/bin'"))).resolves.toBe("/opt/bin:/usr/bin")
  })

  it("gives up on a shell that hangs", async () => {
    const startedAt = Date.now()

    await expect(loginShellPath(fakeShell("hangs", "sleep 30"), 300)).resolves.toBeNull()
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  // An interactive zsh ignores SIGTERM, so only SIGKILL ends a hung startup file.
  it.skipIf(!existsSync("/bin/zsh"))("gives up on an interactive zsh whose startup file hangs", async () => {
    const zdotdir = join(dir, "zdotdir")
    mkdirSync(zdotdir)
    writeFileSync(join(zdotdir, ".zshrc"), "sleep 30\n")
    const previous = process.env.ZDOTDIR
    process.env.ZDOTDIR = zdotdir
    try {
      const startedAt = Date.now()
      await expect(loginShellPath("/bin/zsh", 300)).resolves.toBeNull()
      expect(Date.now() - startedAt).toBeLessThan(5_000)
    } finally {
      if (previous === undefined) delete process.env.ZDOTDIR
      else process.env.ZDOTDIR = previous
    }
  })

  it("does not wait on a startup file that reads input", async () => {
    await expect(loginShellPath(fakeShell("prompts", "read answer\nprintf '/bin'"), 5_000)).resolves.toBe("/bin")
  })

  it("returns null when the shell fails or prints nothing", async () => {
    await expect(loginShellPath(fakeShell("fails", "exit 1"))).resolves.toBeNull()
    await expect(loginShellPath(fakeShell("silent", "true"))).resolves.toBeNull()
    await expect(loginShellPath(join(dir, "missing"))).resolves.toBeNull()
  })
})
