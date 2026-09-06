// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  isRunning,
  launch,
  readDaemonPid,
  readDevToolsEndpoint,
  reapRunDir,
  shutdownBrowsers,
  startSweeper,
  stop,
  sweep,
  type DaemonDeps,
} from "../../browser/daemons"
import { BrowserNameError, profileDir, runRoot, sessionRunDir, sharedRunDir, shimPath } from "../../browser/paths"

let root = ""
let home = ""
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.COGPIT_BROWSER_HOME
  root = mkdtempSync(join(tmpdir(), "cogpit-browser-"))
  home = join(root, "browser")
  process.env.COGPIT_BROWSER_HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.COGPIT_BROWSER_HOME
  else process.env.COGPIT_BROWSER_HOME = previousHome
  rmSync(root, { recursive: true, force: true })
})

interface SpawnCall {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

interface FakeDeps extends DaemonDeps {
  calls: string[]
  spawns: SpawnCall[]
  kills: { pid: number; signal: NodeJS.Signals }[]
  probes: number[]
}

interface FakeOptions {
  alive?: number[]
  probe?: boolean
  spawnResult?: { code: number; stderr: string }
  spawnError?: Error
}

function fakeDeps(options: FakeOptions = {}): FakeDeps {
  const alive = new Set(options.alive ?? [])
  const deps: FakeDeps = {
    calls: [],
    spawns: [],
    kills: [],
    probes: [],
    spawn: async (command, args, env) => {
      deps.calls.push(`spawn ${args.join(" ")}`)
      deps.spawns.push({ command, args, env })
      if (options.spawnError) throw options.spawnError
      return options.spawnResult ?? { code: 0, stderr: "" }
    },
    probe: async (port) => {
      deps.calls.push(`probe ${port}`)
      deps.probes.push(port)
      return options.probe ?? false
    },
    kill: (pid, signal) => {
      deps.calls.push(`kill ${pid} ${signal}`)
      deps.kills.push({ pid, signal })
      alive.delete(pid)
      return true
    },
    isPidAlive: (pid) => alive.has(pid),
  }
  return deps
}

function writePid(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.pid`), content)
  writeFileSync(join(dir, `${name}.sock`), "")
}

function writeEndpoint(name: string, content: string): void {
  mkdirSync(profileDir(name), { recursive: true })
  writeFileSync(join(profileDir(name), "DevToolsActivePort"), content)
}

function runFiles(dir: string, name: string): boolean[] {
  return [existsSync(join(dir, `${name}.pid`)), existsSync(join(dir, `${name}.sock`))]
}

function killedPids(deps: FakeDeps): number[] {
  return deps.kills.map((k) => k.pid).sort((a, b) => a - b)
}

describe("readDevToolsEndpoint", () => {
  it("parses the port and browser websocket path", () => {
    writeEndpoint("work", "41235\n/devtools/browser/0c1a4e2b-1234-4e1f-9f1a-abcdefabcdef\n")
    expect(readDevToolsEndpoint("work")).toEqual({
      port: 41235,
      browserWsUrl: "ws://127.0.0.1:41235/devtools/browser/0c1a4e2b-1234-4e1f-9f1a-abcdefabcdef",
    })
  })

  it("returns null when the file is missing", () => {
    expect(readDevToolsEndpoint("work")).toBeNull()
  })

  it("returns null for garbage", () => {
    writeEndpoint("work", "not-a-port\n/devtools/browser/x\n")
    expect(readDevToolsEndpoint("work")).toBeNull()
    writeEndpoint("work", "41235\ndevtools/browser/x\n")
    expect(readDevToolsEndpoint("work")).toBeNull()
  })

  it("returns null when only the port line is present", () => {
    writeEndpoint("work", "41235\n")
    expect(readDevToolsEndpoint("work")).toBeNull()
  })

  it("rejects throwaway and malformed names before touching the disk", () => {
    expect(() => readDevToolsEndpoint("tmp-x")).toThrow(BrowserNameError)
    expect(() => readDevToolsEndpoint("../x")).toThrow(BrowserNameError)
  })
})

describe("readDaemonPid", () => {
  it("reads the integer from the shared run dir by default", () => {
    writePid(sharedRunDir(), "work", "4242\n")
    expect(readDaemonPid("work")).toBe(4242)
  })

  it("reads from the given run dir", () => {
    writePid(sessionRunDir("sess1"), "tmp-a", "77")
    expect(readDaemonPid("tmp-a", sessionRunDir("sess1"))).toBe(77)
  })

  it("returns null when the file is missing or unreadable", () => {
    expect(readDaemonPid("work")).toBeNull()
    writePid(sharedRunDir(), "work", "abc")
    expect(readDaemonPid("work")).toBeNull()
    writePid(sharedRunDir(), "work", "")
    expect(readDaemonPid("work")).toBeNull()
    writePid(sharedRunDir(), "work", "-5")
    expect(readDaemonPid("work")).toBeNull()
  })

  it("rejects malformed names", () => {
    expect(() => readDaemonPid("../x")).toThrow(BrowserNameError)
  })
})

describe("isRunning", () => {
  it("is false without a pid file and never probes", async () => {
    const deps = fakeDeps({ alive: [100], probe: true })
    expect(await isRunning("work", deps)).toBe(false)
    expect(deps.probes).toEqual([])
  })

  it("is false when the pid is dead and never probes", async () => {
    writePid(sharedRunDir(), "work", "100")
    writeEndpoint("work", "41235\n/devtools/browser/x\n")
    const deps = fakeDeps({ probe: true })
    expect(await isRunning("work", deps)).toBe(false)
    expect(deps.probes).toEqual([])
  })

  it("is false when the pid is alive but there is no endpoint file", async () => {
    writePid(sharedRunDir(), "work", "100")
    const deps = fakeDeps({ alive: [100], probe: true })
    expect(await isRunning("work", deps)).toBe(false)
    expect(deps.probes).toEqual([])
  })

  it("is false when the pid is alive but the stale endpoint does not answer", async () => {
    writePid(sharedRunDir(), "work", "100")
    writeEndpoint("work", "41235\n/devtools/browser/x\n")
    const deps = fakeDeps({ alive: [100], probe: false })
    expect(await isRunning("work", deps)).toBe(false)
    expect(deps.probes).toEqual([41235])
  })

  it("is true when the pid is alive and the endpoint answers", async () => {
    writePid(sharedRunDir(), "work", "100")
    writeEndpoint("work", "41235\n/devtools/browser/x\n")
    const deps = fakeDeps({ alive: [100], probe: true })
    expect(await isRunning("work", deps)).toBe(true)
    expect(deps.probes).toEqual([41235])
  })

  it("rejects throwaway and malformed names", async () => {
    await expect(isRunning("tmp-x", fakeDeps())).rejects.toThrow(BrowserNameError)
    await expect(isRunning("../x", fakeDeps())).rejects.toThrow(BrowserNameError)
  })
})

describe("launch", () => {
  let previousSessionId: string | undefined

  beforeEach(() => {
    previousSessionId = process.env.COGPIT_SESSION_ID
  })

  afterEach(() => {
    if (previousSessionId === undefined) delete process.env.COGPIT_SESSION_ID
    else process.env.COGPIT_SESSION_ID = previousSessionId
  })

  it("runs the shim with the session and url, tagging the driver", async () => {
    const deps = fakeDeps()
    await launch("work", "https://example.com", "sess1", deps)
    expect(deps.spawns).toHaveLength(1)
    const [call] = deps.spawns
    expect(call.command).toBe(shimPath())
    expect(call.args).toEqual(["--session", "work", "open", "https://example.com"])
    expect(call.env.COGPIT_SESSION_ID).toBe("sess1")
    expect(call.env.PATH).toBe(process.env.PATH)
  })

  it("leaves COGPIT_SESSION_ID unset when no session drives the launch", async () => {
    process.env.COGPIT_SESSION_ID = "inherited"
    const deps = fakeDeps()
    await launch("work", "https://example.com", undefined, deps)
    expect("COGPIT_SESSION_ID" in deps.spawns[0].env).toBe(false)
  })

  it("throws with the exit code and stderr on failure", async () => {
    const deps = fakeDeps({ spawnResult: { code: 3, stderr: "boom\n" } })
    await expect(launch("work", "https://example.com", undefined, deps)).rejects.toThrow("agent-browser failed (3): boom")
  })

  it("propagates spawn errors", async () => {
    const deps = fakeDeps({ spawnError: new Error("ENOENT") })
    await expect(launch("work", "https://example.com", undefined, deps)).rejects.toThrow("ENOENT")
  })

  it("rejects throwaway and malformed names before spawning", async () => {
    const deps = fakeDeps()
    await expect(launch("tmp-x", "https://example.com", undefined, deps)).rejects.toThrow(BrowserNameError)
    await expect(launch("../x", "https://example.com", undefined, deps)).rejects.toThrow(BrowserNameError)
    expect(deps.spawns).toEqual([])
  })
})

describe("stop", () => {
  it("closes politely, then terminates the daemon and removes its files", async () => {
    writePid(sharedRunDir(), "work", "100")
    const deps = fakeDeps({ alive: [100] })
    await stop("work", deps)
    expect(deps.calls).toEqual(["spawn --session work close", "kill 100 SIGTERM"])
    expect(deps.spawns[0].command).toBe(shimPath())
    expect(runFiles(sharedRunDir(), "work")).toEqual([false, false])
  })

  it("still terminates when the close command fails", async () => {
    writePid(sharedRunDir(), "work", "100")
    const deps = fakeDeps({ alive: [100], spawnResult: { code: 1, stderr: "no browser" } })
    await stop("work", deps)
    expect(deps.kills).toEqual([{ pid: 100, signal: "SIGTERM" }])
    expect(runFiles(sharedRunDir(), "work")).toEqual([false, false])
  })

  it("still terminates when the shim cannot be spawned", async () => {
    writePid(sharedRunDir(), "work", "100")
    const deps = fakeDeps({ alive: [100], spawnError: new Error("ENOENT") })
    await stop("work", deps)
    expect(deps.kills).toEqual([{ pid: 100, signal: "SIGTERM" }])
  })

  it("tolerates a missing pid file", async () => {
    const deps = fakeDeps()
    await stop("work", deps)
    expect(deps.calls).toEqual(["spawn --session work close"])
  })

  it("rejects throwaway and malformed names before spawning", async () => {
    const deps = fakeDeps()
    await expect(stop("tmp-x", deps)).rejects.toThrow(BrowserNameError)
    await expect(stop("../x", deps)).rejects.toThrow(BrowserNameError)
    expect(deps.spawns).toEqual([])
  })
})

describe("reapRunDir", () => {
  it("terminates every pid and removes the directory", () => {
    const dir = sessionRunDir("sess1")
    writePid(dir, "tmp-a", "10")
    writePid(dir, "tmp-b", "20")
    writePid(dir, "tmp-c", "garbage")
    const deps = fakeDeps({ alive: [10, 20] })
    reapRunDir(dir, deps)
    expect(killedPids(deps)).toEqual([10, 20])
    expect(deps.kills.every((k) => k.signal === "SIGTERM")).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })

  it("is a no-op for a missing directory", () => {
    const deps = fakeDeps()
    expect(() => reapRunDir(join(runRoot(), "nope"), deps)).not.toThrow()
    expect(deps.kills).toEqual([])
  })
})

describe("sweep", () => {
  it("is safe before the run tree exists", () => {
    expect(() => sweep(() => true, fakeDeps())).not.toThrow()
  })

  it("drops dead shared pid files and keeps live ones", () => {
    writePid(sharedRunDir(), "dead", "100")
    writePid(sharedRunDir(), "live", "200")
    writePid(sharedRunDir(), "junk", "???")
    const deps = fakeDeps({ alive: [200] })
    sweep(() => true, deps)
    expect(runFiles(sharedRunDir(), "dead")).toEqual([false, false])
    expect(runFiles(sharedRunDir(), "junk")).toEqual([false, false])
    expect(runFiles(sharedRunDir(), "live")).toEqual([true, true])
    expect(deps.kills).toEqual([])
  })

  it("reaps session dirs whose session is gone and keeps live ones", () => {
    writePid(sessionRunDir("gone"), "tmp-a", "10")
    writePid(sessionRunDir("here"), "tmp-b", "20")
    const deps = fakeDeps({ alive: [10, 20] })
    sweep((id) => id === "here", deps)
    expect(existsSync(sessionRunDir("gone"))).toBe(false)
    expect(existsSync(sessionRunDir("here"))).toBe(true)
    expect(deps.kills).toEqual([{ pid: 10, signal: "SIGTERM" }])
  })

  it("never reaps the shared dir, even when nothing is live", () => {
    writePid(sharedRunDir(), "live", "200")
    const deps = fakeDeps({ alive: [200] })
    sweep(() => false, deps)
    expect(existsSync(sharedRunDir())).toBe(true)
    expect(runFiles(sharedRunDir(), "live")).toEqual([true, true])
  })

  it("reaps dirs whose name is not a session id without asking", () => {
    const weird = join(runRoot(), "not a session id")
    writePid(weird, "tmp-a", "10")
    const isLive = vi.fn(() => true)
    const deps = fakeDeps({ alive: [10] })
    sweep(isLive, deps)
    expect(existsSync(weird)).toBe(false)
    expect(isLive).not.toHaveBeenCalled()
    expect(deps.kills).toEqual([{ pid: 10, signal: "SIGTERM" }])
  })
})

describe("shutdownBrowsers", () => {
  it("is safe before the run tree exists", async () => {
    await expect(shutdownBrowsers(fakeDeps())).resolves.toBeUndefined()
  })

  it("reaps every session dir and stops every named daemon", async () => {
    writePid(sessionRunDir("sess1"), "tmp-a", "10")
    writePid(sessionRunDir("sess2"), "tmp-b", "20")
    writePid(sharedRunDir(), "default", "100")
    writePid(sharedRunDir(), "work", "200")
    const deps = fakeDeps({ alive: [10, 20, 100, 200] })
    await shutdownBrowsers(deps)
    expect(existsSync(sessionRunDir("sess1"))).toBe(false)
    expect(existsSync(sessionRunDir("sess2"))).toBe(false)
    expect(deps.spawns.map((s) => s.args.join(" ")).sort()).toEqual([
      "--session default close",
      "--session work close",
    ])
    expect(killedPids(deps)).toEqual([10, 20, 100, 200])
    expect(runFiles(sharedRunDir(), "default")).toEqual([false, false])
    expect(runFiles(sharedRunDir(), "work")).toEqual([false, false])
  })

  it("terminates throwaways that landed in the shared dir without a close", async () => {
    writePid(sharedRunDir(), "tmp-orphan", "300")
    const deps = fakeDeps({ alive: [300] })
    await shutdownBrowsers(deps)
    expect(deps.spawns).toEqual([])
    expect(deps.kills).toEqual([{ pid: 300, signal: "SIGTERM" }])
    expect(runFiles(sharedRunDir(), "tmp-orphan")).toEqual([false, false])
  })

  it("keeps going when one stop fails", async () => {
    writePid(sharedRunDir(), "default", "100")
    writePid(sharedRunDir(), "work", "200")
    const deps = fakeDeps({ alive: [100, 200], spawnError: new Error("ENOENT") })
    await shutdownBrowsers(deps)
    expect(killedPids(deps)).toEqual([100, 200])
  })
})

describe("startSweeper", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("sweeps immediately, then on the interval, until stopped", () => {
    writePid(sharedRunDir(), "first", "100")
    const deps = fakeDeps()
    const stopSweeper = startSweeper(() => true, 1_000, deps)
    expect(runFiles(sharedRunDir(), "first")).toEqual([false, false])

    writePid(sharedRunDir(), "second", "101")
    vi.advanceTimersByTime(1_000)
    expect(runFiles(sharedRunDir(), "second")).toEqual([false, false])

    stopSweeper()
    writePid(sharedRunDir(), "third", "102")
    vi.advanceTimersByTime(5_000)
    expect(runFiles(sharedRunDir(), "third")).toEqual([true, true])
  })

  it("swallows sweep errors so the timer keeps running", () => {
    writePid(sessionRunDir("sess1"), "tmp-a", "10")
    const isLive = vi.fn(() => {
      throw new Error("registry unavailable")
    })
    const deps = fakeDeps({ alive: [10] })
    const stopSweeper = startSweeper(isLive, 1_000, deps)
    expect(isLive).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1_000)
    expect(isLive).toHaveBeenCalledTimes(2)
    stopSweeper()
  })
})
