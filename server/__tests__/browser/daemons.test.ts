// @vitest-environment node
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  acquireSweepOwnership,
  defaultDaemonDeps,
  holdsSweepOwnership,
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
import {
  BrowserNameError,
  profileDir,
  runRoot,
  sharedRunDir,
  shimPath,
  sweepOwnerFile,
} from "../../browser/paths"

/** One Cogpit session's throwaway-browser directory. */
function sessionRunDir(id: string): string {
  return join(runRoot(), id)
}

/** Only the owner reaps named daemons, so a test about them has to claim the tree. */
function ownTree(): void {
  mkdirSync(join(root, "browser"), { recursive: true })
  expect(acquireSweepOwnership(fakeDeps())).toBe(true)
}

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

  it("returns null for a port outside the TCP range", () => {
    writeEndpoint("work", "65536\n/devtools/browser/x\n")
    expect(readDevToolsEndpoint("work")).toBeNull()
    writeEndpoint("work", "0\n/devtools/browser/x\n")
    expect(readDevToolsEndpoint("work")).toBeNull()
    writeEndpoint("work", "65535\n/devtools/browser/x\n")
    expect(readDevToolsEndpoint("work")?.port).toBe(65535)
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

  it("rejects a url that could be parsed as a flag before spawning", async () => {
    const deps = fakeDeps()
    await expect(launch("work", "--headed", undefined, deps)).rejects.toThrow('must not start with "-"')
    expect(deps.spawns).toEqual([])
  })

  it.each([
    "file:///Users/x/.ssh/id_rsa",
    "javascript:alert(1)",
    "data:text/html,hi",
    "chrome://settings",
  ])("refuses to open %s", async (url) => {
    const deps = fakeDeps()
    await expect(launch("work", url, undefined, deps)).rejects.toThrow(/Refusing to navigate/)
    expect(deps.spawns).toEqual([])
  })

  it.each([
    ["example.com", "https://example.com"],
    ["localhost:3000", "http://localhost:3000"],
  ])("normalises %s to %s before spawning", async (url, expected) => {
    const deps = fakeDeps()
    await launch("work", url, undefined, deps)
    expect(deps.spawns[0].args).toEqual(["--session", "work", "open", expected])
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
  let previousSessionId: string | undefined

  beforeEach(() => {
    previousSessionId = process.env.COGPIT_SESSION_ID
  })

  afterEach(() => {
    if (previousSessionId === undefined) delete process.env.COGPIT_SESSION_ID
    else process.env.COGPIT_SESSION_ID = previousSessionId
  })

  it("closes politely, then terminates the daemon and removes its files", async () => {
    writePid(sharedRunDir(), "work", "100")
    const deps = fakeDeps({ alive: [100] })
    await stop("work", deps)
    expect(deps.calls).toEqual(["spawn --session work close", "kill 100 SIGTERM"])
    expect(deps.spawns[0].command).toBe(shimPath())
    expect(runFiles(sharedRunDir(), "work")).toEqual([false, false])
  })

  it("removes the .port file a Windows daemon leaves beside its pid", async () => {
    writePid(sharedRunDir(), "work", "100")
    writeFileSync(join(sharedRunDir(), "work.port"), "51234")
    await stop("work", fakeDeps({ alive: [100] }))
    expect(existsSync(join(sharedRunDir(), "work.port"))).toBe(false)
  })

  it("never lets the close inherit the server's own COGPIT_SESSION_ID", async () => {
    process.env.COGPIT_SESSION_ID = "inherited"
    writePid(sharedRunDir(), "work", "100")
    const deps = fakeDeps({ alive: [100] })
    await stop("work", deps)
    expect("COGPIT_SESSION_ID" in deps.spawns[0].env).toBe(false)
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

  it("does nothing when there is no pid file, so the shim never spawns a fresh daemon", async () => {
    const deps = fakeDeps()
    await stop("work", deps)
    expect(deps.calls).toEqual([])
  })

  it("only removes the files when the pid is dead", async () => {
    writePid(sharedRunDir(), "work", "100")
    const deps = fakeDeps()
    await stop("work", deps)
    expect(deps.calls).toEqual([])
    expect(runFiles(sharedRunDir(), "work")).toEqual([false, false])
  })

  it("rejects throwaway and malformed names before spawning", async () => {
    const deps = fakeDeps()
    await expect(stop("tmp-x", deps)).rejects.toThrow(BrowserNameError)
    await expect(stop("../x", deps)).rejects.toThrow(BrowserNameError)
    expect(deps.spawns).toEqual([])
  })

  it("escalates to SIGKILL for a daemon that ignores SIGTERM", async () => {
    vi.useFakeTimers()
    try {
      writePid(sharedRunDir(), "work", "100")
      const deps = fakeDeps({ alive: [100] })
      // A daemon that stays alive through every signal.
      deps.kill = (pid, signal) => {
        deps.kills.push({ pid, signal })
        return true
      }

      const stopping = stop("work", deps)
      await vi.advanceTimersByTimeAsync(5_000)
      await stopping

      expect(deps.kills).toEqual([
        { pid: 100, signal: "SIGTERM" },
        { pid: 100, signal: "SIGKILL" },
      ])
    } finally {
      vi.useRealTimers()
    }
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
    const deps = fakeDeps({ alive: [200] })
    sweep(() => true, deps)
    expect(runFiles(sharedRunDir(), "dead")).toEqual([false, false])
    expect(runFiles(sharedRunDir(), "live")).toEqual([true, true])
    expect(deps.kills).toEqual([])
  })

  it("keeps a fresh unparsable pid file, since a starting daemon may still be writing it", () => {
    writePid(sharedRunDir(), "junk", "???")
    sweep(() => true, fakeDeps())
    expect(runFiles(sharedRunDir(), "junk")).toEqual([true, true])
  })

  it("drops an unparsable pid file once it is older than a minute", () => {
    writePid(sharedRunDir(), "junk", "???")
    const twoMinutesAgo = new Date(Date.now() - 120_000)
    utimesSync(join(sharedRunDir(), "junk.pid"), twoMinutesAgo, twoMinutesAgo)
    sweep(() => true, fakeDeps())
    expect(runFiles(sharedRunDir(), "junk")).toEqual([false, false])
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
    ownTree()
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
    ownTree()
    writePid(sharedRunDir(), "tmp-orphan", "300")
    const deps = fakeDeps({ alive: [300] })
    await shutdownBrowsers(deps)
    expect(deps.spawns).toEqual([])
    expect(deps.kills).toEqual([{ pid: 300, signal: "SIGTERM" }])
    expect(runFiles(sharedRunDir(), "tmp-orphan")).toEqual([false, false])
  })

  it("still terminates every daemon when close cannot be spawned", async () => {
    ownTree()
    writePid(sharedRunDir(), "default", "100")
    writePid(sharedRunDir(), "work", "200")
    const deps = fakeDeps({ alive: [100, 200], spawnError: new Error("ENOENT") })
    await shutdownBrowsers(deps)
    expect(killedPids(deps)).toEqual([100, 200])
  })

  it("hands ownership on, so the next Cogpit to start may sweep", async () => {
    ownTree()
    await shutdownBrowsers(fakeDeps())
    expect(existsSync(sweepOwnerFile())).toBe(false)
  })

  it("leaves another Cogpit's named daemons running, but still drops its own throwaways", async () => {
    mkdirSync(join(root, "browser"), { recursive: true })
    writeFileSync(sweepOwnerFile(), JSON.stringify({ pid: 4242, startedAt: 1 }))
    writePid(sessionRunDir("sess1"), "tmp-a", "10")
    writePid(sharedRunDir(), "default", "100")
    const deps = fakeDeps({ alive: [10, 100, 4242] })

    await shutdownBrowsers(deps)

    expect(existsSync(sessionRunDir("sess1"))).toBe(false)
    expect(killedPids(deps)).toEqual([10])
    expect(deps.spawns).toEqual([])
    expect(runFiles(sharedRunDir(), "default")).toEqual([true, true])
    expect(existsSync(sweepOwnerFile())).toBe(true)
  })

  it("gives up on a daemon that will not stop rather than holding the app open", async () => {
    vi.useFakeTimers()
    try {
      ownTree()
      writePid(sharedRunDir(), "default", "100")
      const deps = fakeDeps({ alive: [100] })
      // A close that never returns is exactly the wedged daemon this bounds.
      deps.spawn = () => new Promise(() => {})

      const shutdown = shutdownBrowsers(deps)
      const settled = expect(shutdown).rejects.toThrow(/did not stop/)
      await vi.advanceTimersByTimeAsync(20_000)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("sweep ownership", () => {
  beforeEach(() => {
    mkdirSync(join(root, "browser"), { recursive: true })
  })

  it("acquires an unclaimed tree and reports holding it", () => {
    expect(holdsSweepOwnership()).toBe(false)
    expect(acquireSweepOwnership(fakeDeps())).toBe(true)
    expect(holdsSweepOwnership()).toBe(true)
    expect(JSON.parse(readFileSync(sweepOwnerFile(), "utf8")).pid).toBe(process.pid)
  })

  it("is idempotent for the process that already holds it", () => {
    acquireSweepOwnership(fakeDeps())
    const before = readFileSync(sweepOwnerFile(), "utf8")
    expect(acquireSweepOwnership(fakeDeps())).toBe(true)
    expect(readFileSync(sweepOwnerFile(), "utf8")).toBe(before)
  })

  it("declines while another live Cogpit holds it", () => {
    writeFileSync(sweepOwnerFile(), JSON.stringify({ pid: 4242, startedAt: 1 }))
    expect(acquireSweepOwnership(fakeDeps({ alive: [4242] }))).toBe(false)
    expect(holdsSweepOwnership()).toBe(false)
  })

  it("takes over from an owner whose process is gone", () => {
    writeFileSync(sweepOwnerFile(), JSON.stringify({ pid: 4242, startedAt: 1 }))
    expect(acquireSweepOwnership(fakeDeps())).toBe(true)
    expect(holdsSweepOwnership()).toBe(true)
  })

  it("takes over an unreadable owner file", () => {
    writeFileSync(sweepOwnerFile(), "not json")
    expect(acquireSweepOwnership(fakeDeps())).toBe(true)
  })

  it("does not read a pid file naming this process as a claim by a stale twin", () => {
    writeFileSync(sweepOwnerFile(), JSON.stringify({ pid: process.pid, startedAt: 1 }))
    expect(holdsSweepOwnership()).toBe(false)
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

  it("leaves the tree alone while another live Cogpit owns it", () => {
    mkdirSync(join(root, "browser"), { recursive: true })
    writeFileSync(sweepOwnerFile(), JSON.stringify({ pid: 4242, startedAt: 1 }))
    writePid(sharedRunDir(), "dead", "100")

    const stopSweeper = startSweeper(() => true, 1_000, fakeDeps({ alive: [4242] }))

    expect(runFiles(sharedRunDir(), "dead")).toEqual([true, true])
    stopSweeper()
  })

  it("takes the tree over on a later tick once that Cogpit is gone", () => {
    mkdirSync(join(root, "browser"), { recursive: true })
    writeFileSync(sweepOwnerFile(), JSON.stringify({ pid: 4242, startedAt: 1 }))
    writePid(sharedRunDir(), "dead", "100")
    const alive = [4242]
    const deps = fakeDeps({ alive })

    const stopSweeper = startSweeper(() => true, 1_000, deps)
    expect(runFiles(sharedRunDir(), "dead")).toEqual([true, true])

    deps.isPidAlive = () => false
    vi.advanceTimersByTime(1_000)

    expect(runFiles(sharedRunDir(), "dead")).toEqual([false, false])
    expect(holdsSweepOwnership()).toBe(true)
    stopSweeper()
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

describe("defaultDaemonDeps.spawn", () => {
  it("kills a shim call that never finishes and rejects", async () => {
    vi.useFakeTimers()
    try {
      const running = defaultDaemonDeps.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], process.env)
      const settled = expect(running).rejects.toThrow(/did not finish in 30s/)
      await vi.advanceTimersByTimeAsync(30_000)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })

  it("resolves with the exit code and stderr of a command that does finish", async () => {
    const result = await defaultDaemonDeps.spawn(process.execPath, ["-e", "console.error('boom'); process.exit(3)"], process.env)
    expect(result.code).toBe(3)
    expect(result.stderr.trim()).toBe("boom")
  })

  it.skipIf(process.platform === "win32")("runs a .cmd shim through the command interpreter on Windows", async () => {
    // COMSPEC stands in for cmd.exe: it echoes the line it was handed.
    const comspec = join(root, "comspec.sh")
    writeFileSync(comspec, "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" >&2\n", { mode: 0o755 })
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "win32" })
    try {
      const result = await defaultDaemonDeps.spawn("C:\\bin\\agent-browser.cmd", ["--session", "work", "open", "https://x/?a=1&b=2"], { ...process.env, COMSPEC: comspec })
      expect(result.code).toBe(0)
      expect(result.stderr.split("\n").slice(0, 3)).toEqual(["/d", "/s", "/c"])
      expect(result.stderr).toContain("C:\\bin\\agent-browser.cmd")
      expect(result.stderr).toContain('^"work^"')
      expect(result.stderr).toContain("a=1^&b=2")
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform })
    }
  })
})

describe("defaultDaemonDeps.kill", () => {
  it("refuses to signal a process that is not an agent-browser daemon", () => {
    expect(defaultDaemonDeps.kill(process.pid, "SIGTERM")).toBe(false)
  })

  it("returns false for a pid that has already exited", () => {
    const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid
    expect(exited).toBeGreaterThan(0)
    expect(defaultDaemonDeps.kill(exited, "SIGTERM")).toBe(false)
  })
})
