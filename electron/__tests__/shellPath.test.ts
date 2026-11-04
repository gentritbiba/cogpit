// @vitest-environment node
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { loginShellPath } from "../shellPath"

const dir = mkdtempSync(join(tmpdir(), "cogpit-shell-path-"))
let scripts = 0

/** A stand-in login shell: a script that ignores its -ilc arguments. */
function fakeShell(body: string): string {
  const path = join(dir, `shell-${scripts++}`)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

function pidFile(): string {
  return join(dir, `pid-${scripts}`)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A killed process lingers as a zombie until its new parent reaps it. */
async function expectGone(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (isAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
  expect(isAlive(pid)).toBe(false)
}

function recordedPid(path: string): number {
  return Number(readFileSync(path, "utf8").trim())
}

describe.skipIf(process.platform === "win32")("loginShellPath", () => {
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("returns the PATH the shell prints", async () => {
    await expect(loginShellPath(fakeShell("printf '/opt/bin:/usr/bin'"))).resolves.toBe("/opt/bin:/usr/bin")
  })

  it("gives up on a hung startup command and leaves none of its processes behind", async () => {
    const pids = pidFile()
    const shell = fakeShell(`sh -c 'echo $$ > "${pids}"; exec sleep 30'`)
    const startedAt = Date.now()

    await expect(loginShellPath(shell, { timeoutMs: 1_500 })).resolves.toBeNull()

    expect(Date.now() - startedAt).toBeLessThan(6_000)
    await expectGone(recordedPid(pids))
  })

  it("does not wait for, or leave behind, a job the startup file put in the background", async () => {
    const pids = pidFile()
    const shell = fakeShell(`sleep 30 &\necho $! > "${pids}"\nprintf '/bin'`)
    const startedAt = Date.now()

    await expect(loginShellPath(shell, { timeoutMs: 5_000 })).resolves.toBe("/bin")

    expect(Date.now() - startedAt).toBeLessThan(2_000)
    await expectGone(recordedPid(pids))
  })

  it("stops the probe and its processes when the app quits first", async () => {
    const pids = pidFile()
    const shell = fakeShell(`sleep 30 &\necho $! > "${pids}"\nwait`)
    const quit = new AbortController()

    const probe = loginShellPath(shell, { timeoutMs: 30_000, signal: quit.signal })
    while (!existsSync(pids) || !readFileSync(pids, "utf8").trim()) await new Promise((resolve) => setTimeout(resolve, 10))
    quit.abort()

    await expect(probe).resolves.toBeNull()
    await expectGone(recordedPid(pids))
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
      await expect(loginShellPath("/bin/zsh", { timeoutMs: 300 })).resolves.toBeNull()
      expect(Date.now() - startedAt).toBeLessThan(5_000)
    } finally {
      if (previous === undefined) delete process.env.ZDOTDIR
      else process.env.ZDOTDIR = previous
    }
  })

  it("does not wait on a startup file that reads input", async () => {
    await expect(loginShellPath(fakeShell("read answer\nprintf '/bin'"), { timeoutMs: 5_000 })).resolves.toBe("/bin")
  })

  it("returns null when the shell fails or prints nothing", async () => {
    await expect(loginShellPath(fakeShell("exit 1"))).resolves.toBeNull()
    await expect(loginShellPath(fakeShell("true"))).resolves.toBeNull()
    await expect(loginShellPath(join(dir, "missing"))).resolves.toBeNull()
  })
})
