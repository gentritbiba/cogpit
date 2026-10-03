// @vitest-environment node

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockPtySpawn = vi.hoisted(() => vi.fn())
vi.mock("node-pty", () => ({ spawn: mockPtySpawn }))

import { bunTerminalRuntime, spawnPty, type BunTerminalRuntime } from "../pty-backend"

const options = { cols: 120, rows: 40, cwd: "/tmp", env: { TERM: "xterm-256color" } }

/** Run `fn` as if the server were on `platform`. */
function onPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { ...original, value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, "platform", original)
  }
}

function fakeBunRuntime() {
  const terminal = {
    options: null as null | { cols: number; rows: number; data: (terminal: unknown, chunk: Uint8Array) => void },
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
  }
  let resolveExit: (code: number) => void = () => {}
  const subprocess = {
    pid: 777,
    exited: new Promise<number>((resolve) => { resolveExit = resolve }),
    kill: vi.fn(),
  }
  const spawn = vi.fn(() => subprocess)
  const runtime: BunTerminalRuntime = {
    Terminal: class {
      constructor(opts: typeof terminal.options) {
        terminal.options = opts
        return terminal as never
      }
    } as never,
    spawn: spawn as never,
  }
  return { runtime, terminal, subprocess, spawn, exit: (code: number) => resolveExit(code) }
}

describe("bunTerminalRuntime", () => {
  it("is null outside Bun and on Windows", () => {
    expect(bunTerminalRuntime({})).toBeNull()
    expect(bunTerminalRuntime({ Bun: { spawn() {} } })).toBeNull()
    onPlatform("win32", () => {
      expect(bunTerminalRuntime({ Bun: { spawn() {}, Terminal: class {} } })).toBeNull()
    })
  })

  it("returns Bun's global when its terminal API exists on POSIX", () => {
    const Bun = { spawn() {}, Terminal: class {} }
    onPlatform("linux", () => {
      expect(bunTerminalRuntime({ Bun })).toBe(Bun)
    })
  })
})

describe("spawnPty", () => {
  let pathDir: string
  const originalPath = process.env.PATH

  beforeEach(() => {
    mockPtySpawn.mockReset()
    pathDir = mkdtempSync(join(tmpdir(), "pty-backend-"))
    process.env.PATH = pathDir
  })

  afterEach(() => {
    process.env.PATH = originalPath
    rmSync(pathDir, { recursive: true, force: true })
  })

  it("hands the spawn to node-pty without a Bun runtime", () => {
    const nodePty = { pid: 1 }
    mockPtySpawn.mockReturnValue(nodePty)

    const pty = spawnPty("/bin/bash", ["-l"], options, null)

    expect(pty).toBe(nodePty)
    expect(mockPtySpawn).toHaveBeenCalledWith("/bin/bash", ["-l"], {
      name: "xterm-256color",
      ...options,
    })
  })

  it("under Bun, bridges Bun.Terminal to the node-pty shape", async () => {
    const bun = fakeBunRuntime()
    const data: string[] = []
    const exits: Array<{ exitCode: number }> = []

    const pty = onPlatform("darwin", () => spawnPty("/bin/zsh", ["-l"], options, bun.runtime))
    pty.onData((chunk) => data.push(chunk))
    pty.onExit((event) => exits.push(event))

    expect(mockPtySpawn).not.toHaveBeenCalled()
    expect(pty.pid).toBe(777)
    expect(bun.terminal.options).toMatchObject({ cols: 120, rows: 40 })
    expect(bun.spawn).toHaveBeenCalledWith(["/bin/zsh", "-l"], {
      cwd: "/tmp",
      env: options.env,
      terminal: bun.terminal,
    })

    const euro = new TextEncoder().encode("€")
    bun.terminal.options!.data(bun.terminal, euro.subarray(0, 1))
    bun.terminal.options!.data(bun.terminal, euro.subarray(1))
    expect(data).toEqual(["€"])

    pty.write("ls\r")
    pty.resize(80, 24)
    pty.kill()
    expect(bun.terminal.write).toHaveBeenCalledWith("ls\r")
    expect(bun.terminal.resize).toHaveBeenCalledWith(80, 24)
    expect(bun.subprocess.kill).toHaveBeenCalledWith("SIGHUP")

    bun.exit(3)
    await bun.subprocess.exited
    await Promise.resolve()
    expect(exits).toEqual([{ exitCode: 3 }])
    expect(bun.terminal.close).toHaveBeenCalledOnce()
  })

  it("on Linux under Bun, starts the command through setsid so the shell owns its terminal", () => {
    const setsid = join(pathDir, "setsid")
    writeFileSync(setsid, "#!/bin/sh\n")
    chmodSync(setsid, 0o755)
    const bun = fakeBunRuntime()

    onPlatform("linux", () => spawnPty("/bin/bash", ["-l"], options, bun.runtime))

    expect(bun.spawn).toHaveBeenCalledWith(
      ["setsid", "--ctty", "--wait", "/bin/bash", "-l"],
      expect.objectContaining({ cwd: "/tmp" }),
    )
  })

  it("on macOS under Bun, starts the command through perl so the shell owns its terminal", () => {
    const perl = join(pathDir, "perl")
    writeFileSync(perl, "#!/bin/sh\n")
    chmodSync(perl, 0o755)
    const bun = fakeBunRuntime()

    onPlatform("darwin", () => spawnPty("/bin/zsh", ["-l"], options, bun.runtime))

    expect(bun.spawn).toHaveBeenCalledWith(
      ["perl", "-e", expect.stringContaining("POSIX::setsid()"), "/bin/zsh", "-l"],
      expect.objectContaining({ cwd: "/tmp" }),
    )
  })

  it("on Linux under Bun without setsid on PATH, spawns the command directly", () => {
    const bun = fakeBunRuntime()

    onPlatform("linux", () => spawnPty("/bin/bash", [], options, bun.runtime))

    expect(bun.spawn).toHaveBeenCalledWith(["/bin/bash"], expect.objectContaining({ cwd: "/tmp" }))
  })
})
