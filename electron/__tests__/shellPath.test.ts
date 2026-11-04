// @vitest-environment node
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest"
import { loginShellPath } from "../shellPath"

const dir = mkdtempSync(join(tmpdir(), "cogpit-shell-path-"))

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

async function recordedPid(path: string): Promise<number> {
  const deadline = Date.now() + 5_000
  while (!(existsSync(path) && readFileSync(path, "utf8").trim()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return Number(readFileSync(path, "utf8").trim())
}

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/**
 * The real login shells, run with a throwaway HOME whose startup file starts a
 * background job (which holds the output pipe open) and, optionally, hangs in
 * the foreground. In bash, `set -m` turns job control on, so those jobs get
 * process groups of their own, as they do where the shell finds a terminal.
 */
describe.each(["/bin/bash", "/bin/zsh"].filter((shell) => existsSync(shell)))("loginShellPath with a real %s", (shell) => {
  let home: string
  const saved = { HOME: process.env.HOME, ZDOTDIR: process.env.ZDOTDIR }

  beforeEach(() => {
    home = mkdtempSync(join(dir, "home-"))
    process.env.HOME = home
    process.env.ZDOTDIR = home
  })

  afterEach(() => {
    // Only the jobs this test's startup file recorded, should an assertion have failed early.
    for (const name of ["background.pid", "foreground.pid"]) {
      const file = join(home, name)
      const pid = existsSync(file) ? Number(readFileSync(file, "utf8").trim()) : 0
      if (pid && isAlive(pid)) process.kill(pid, "SIGKILL")
    }
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  function startupFile({ hang }: { hang: boolean }): void {
    const lines = [
      // zsh refuses job control without a terminal and abandons the file.
      '[ -n "$BASH_VERSION" ] && set -m',
      "sleep 300 &",
      'echo $! > "$HOME/background.pid"',
      ...(hang ? [`sh -c 'echo $$ > "$HOME/foreground.pid"; exec sleep 300'`] : []),
    ]
    for (const name of [".bash_profile", ".zshrc"]) writeFileSync(join(home, name), lines.join("\n") + "\n")
  }

  it("returns the PATH once printed, without waiting for a job that holds the output open", async () => {
    startupFile({ hang: false })
    const startedAt = Date.now()

    const path = await loginShellPath(shell, { timeoutMs: 10_000 })

    expect(path).toMatch(/(^|:)\/usr\/bin(:|$)/)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    await expectGone(await recordedPid(join(home, "background.pid")))
  })

  it("gives up on a hung startup file and leaves none of its processes behind", async () => {
    startupFile({ hang: true })

    await expect(loginShellPath(shell, { timeoutMs: 2_000 })).resolves.toBeNull()

    await expectGone(await recordedPid(join(home, "background.pid")))
    await expectGone(await recordedPid(join(home, "foreground.pid")))
  })

  it("stops the probe and its processes when the app quits first", async () => {
    startupFile({ hang: true })
    const quit = new AbortController()

    const probe = loginShellPath(shell, { timeoutMs: 30_000, signal: quit.signal })
    const background = await recordedPid(join(home, "background.pid"))
    const foreground = await recordedPid(join(home, "foreground.pid"))
    quit.abort()

    await expect(probe).resolves.toBeNull()
    await expectGone(background)
    await expectGone(foreground)
  })
})

describe.skipIf(process.platform === "win32")("loginShellPath with a broken shell", () => {
  function fakeShell(body: string): string {
    const path = join(dir, `shell-${Math.random().toString(36).slice(2)}`)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }

  it("returns null when the shell fails, prints nothing, or is missing", async () => {
    await expect(loginShellPath(fakeShell("exit 1"))).resolves.toBeNull()
    await expect(loginShellPath(fakeShell("true"))).resolves.toBeNull()
    await expect(loginShellPath(join(dir, "missing"))).resolves.toBeNull()
  })
})
