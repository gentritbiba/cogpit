// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process"
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { binDir, shimPath } from "../../browser/paths"
import { ensureShim, findRealAgentBrowser, findVisibleBrowser, renderShim, SHIM_VERSION } from "../../browser/shim"
import { logged, runAtOnce, SLOW_START_BINARY, stopFakeDaemon } from "./singleFlightFixture"

const FAKE_BINARY = [
  "#!/usr/bin/env bash",
  'echo "SESSION_DIR=$AGENT_BROWSER_SOCKET_DIR"',
  'echo "PROFILE=${AGENT_BROWSER_PROFILE:-}"',
  'echo "ARGS=${AGENT_BROWSER_ARGS:-}"',
  'echo "HEADED=${AGENT_BROWSER_HEADED:-}"',
  'echo "EXECUTABLE=${AGENT_BROWSER_EXECUTABLE_PATH:-}"',
  'echo "NAME=${AGENT_BROWSER_SESSION:-}"',
  "printf '[%s]' \"$@\"",
  "",
].join("\n")

let root = ""
let home = ""
let fakeBinDir = ""
let fakeBinary = ""
let shimFile = ""
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.COGPIT_BROWSER_HOME
  root = mkdtempSync(join(tmpdir(), "cogpit-browser-"))
  home = join(root, "browser")
  process.env.COGPIT_BROWSER_HOME = home
  fakeBinDir = join(root, "fake-bin")
  fakeBinary = join(fakeBinDir, "agent-browser")
  mkdirSync(fakeBinDir)
  writeFileSync(fakeBinary, FAKE_BINARY, { mode: 0o755 })
  shimFile = join(root, "shim.sh")
  writeFileSync(shimFile, renderShim(fakeBinary), { mode: 0o755 })
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.COGPIT_BROWSER_HOME
  else process.env.COGPIT_BROWSER_HOME = previousHome
  rmSync(root, { recursive: true, force: true })
})

interface ShimRun {
  sessionDir: string
  profile: string
  args: string
  headed: string
  executable: string
  /** AGENT_BROWSER_SESSION as the real binary sees it. */
  name: string
  argv: string
}

function spawnShim(file: string, args: string[], extraEnv: Record<string, string> = {}) {
  const env = { HOME: root, PATH: process.env.PATH ?? "", COGPIT_BROWSER_HOME: home, ...extraEnv }
  return spawnSync("bash", [file, ...args], { env, encoding: "utf8", timeout: 5_000 })
}

function runShim(args: string[], extraEnv: Record<string, string> = {}, file = shimFile): ShimRun {
  const result = spawnShim(file, args, extraEnv)
  if (result.status !== 0) throw new Error(`shim exited ${result.status}: ${result.stderr}`)
  const [sessionDir, profile, argLine, headed, executable, name, argv = ""] = result.stdout.split("\n")
  return {
    sessionDir: sessionDir.replace(/^SESSION_DIR=/, ""),
    profile: profile.replace(/^PROFILE=/, ""),
    args: argLine.replace(/^ARGS=/, ""),
    headed: headed.replace(/^HEADED=/, ""),
    executable: executable.replace(/^EXECUTABLE=/, ""),
    name: name.replace(/^NAME=/, ""),
    argv,
  }
}

describe("renderShim", () => {
  it("starts with the shebang and the versioned marker line", () => {
    const [shebang, marker, , , real] = renderShim("/opt/bin/agent-browser").split("\n")
    expect(shebang).toBe("#!/usr/bin/env bash")
    expect(marker).toMatch(new RegExp(`^# cogpit-shim v${SHIM_VERSION}\\b`))
    expect(real).toBe('real="/opt/bin/agent-browser"')
  })

  it("escapes shell-significant characters in the real path", () => {
    expect(renderShim('/x/y "z" $HOME `w` \\')).toContain('real="/x/y \\"z\\" \\$HOME \\`w\\` \\\\"')
  })
})

// Native Windows does not execute the POSIX browser shim or implement its mode bits.
describe.skipIf(process.platform === "win32")("shim routing", () => {
  it("defaults to the shared default profile with a debugging port", () => {
    const run = runShim([], { COGPIT_SESSION_ID: "s1" })
    const profile = join(home, "profiles", "default")
    expect(run.profile).toBe(profile)
    expect(run.sessionDir).toBe(join(home, "run", "shared"))
    expect(run.args).toBe("--remote-debugging-port=0")
    expect(run.argv).toBe("[]")
    expect(statSync(profile).isDirectory()).toBe(true)
    expect(statSync(join(home, "run", "shared")).isDirectory()).toBe(true)
    expect(readFileSync(join(profile, ".driver"), "utf8")).toBe("s1\n")
  })

  it("writes an empty .driver for an agent that serves no one session", () => {
    runShim([], { COGPIT_SESSION_ID: "" })
    expect(readFileSync(join(home, "profiles", "default", ".driver"), "utf8")).toBe("\n")
  })

  it("keeps the last driver when Cogpit itself opens or closes the browser", () => {
    runShim([])
    expect(existsSync(join(home, "profiles", "default", ".driver"))).toBe(false)
    runShim([], { COGPIT_SESSION_ID: "s1" })
    runShim([])
    expect(readFileSync(join(home, "profiles", "default", ".driver"), "utf8")).toBe("s1\n")
  })

  it("routes --session <name> into that profile and passes arguments through", () => {
    const run = runShim(["--session", "github", "open", "x"])
    expect(run.profile).toBe(join(home, "profiles", "github"))
    expect(run.sessionDir).toBe(join(home, "run", "shared"))
    expect(run.args).toBe("--remote-debugging-port=0")
    expect(run.argv).toBe("[--session][github][open][x]")
  })

  it("gives tmp-* sessions a per-session socket dir and no profile", () => {
    const run = runShim(["--session=tmp-abc", "snapshot"], { COGPIT_SESSION_ID: "s1" })
    expect(run.sessionDir).toBe(join(home, "run", "s1"))
    expect(run.profile).toBe("")
    expect(run.args).toBe("")
    expect(run.argv).toBe("[--session=tmp-abc][snapshot]")
    expect(statSync(join(home, "run", "s1")).isDirectory()).toBe(true)
    expect(existsSync(join(home, "profiles"))).toBe(false)
  })

  it("falls back to the shared socket dir for tmp-* without a valid session id", () => {
    expect(runShim(["--session", "tmp-1"]).sessionDir).toBe(join(home, "run", "shared"))
    expect(runShim(["--session", "tmp-1"], { COGPIT_SESSION_ID: "../x" }).sessionDir).toBe(join(home, "run", "shared"))
    expect(existsSync(join(home, "profiles"))).toBe(false)
  })

  it("honours AGENT_BROWSER_SESSION when no flag is given", () => {
    const run = runShim(["open", "y"], { AGENT_BROWSER_SESSION: "work" })
    expect(run.profile).toBe(join(home, "profiles", "work"))
    expect(run.argv).toBe("[open][y]")
  })

  it("prefers the --session flag over AGENT_BROWSER_SESSION", () => {
    const run = runShim(["--session", "flag"], { AGENT_BROWSER_SESSION: "env" })
    expect(run.profile).toBe(join(home, "profiles", "flag"))
  })

  it("passes invalid names straight through without touching the tree", () => {
    const run = runShim(["--session", "Bad Name", "open", "x"])
    expect(run.sessionDir).toBe("")
    expect(run.profile).toBe("")
    expect(run.args).toBe("")
    expect(run.argv).toBe("[--session][Bad Name][open][x]")
    expect(existsSync(home)).toBe(false)
  })

  it.each([
    ["upper case", "Foo"],
    ["leading dash", "-foo"],
    ["41 characters", "a".repeat(41)],
  ])("passes a name with %s through under a UTF-8 locale", (_label, name) => {
    const run = runShim(["--session", name], { LC_ALL: "en_US.UTF-8" })
    expect(run.profile).toBe("")
    expect(run.sessionDir).toBe("")
    expect(run.argv).toBe(`[--session][${name}]`)
    expect(existsSync(home)).toBe(false)
  })

  it("keeps the default name when --session is the last argument", () => {
    const run = runShim(["--session"])
    expect(run.profile).toBe(join(home, "profiles", "default"))
    expect(run.argv).toBe("[--session]")
  })

  it("refuses to run when the real binary is missing", () => {
    const missing = join(root, "missing", "agent-browser")
    const brokenShim = join(root, "broken.sh")
    writeFileSync(brokenShim, renderShim(missing), { mode: 0o755 })
    const result = spawnShim(brokenShim, ["open", "x"], { COGPIT_SESSION_ID: "s1" })
    expect(result.status).toBe(127)
    expect(result.stderr).toContain("restart Cogpit")
    expect(existsSync(home)).toBe(false)
  })

  it("refuses to run when the real binary is the shim itself", () => {
    const selfShim = join(root, "self.sh")
    writeFileSync(selfShim, renderShim(selfShim), { mode: 0o755 })
    const result = spawnShim(selfShim, ["open", "x"])
    expect(result.status).toBe(127)
    expect(result.stderr).toContain("restart Cogpit")
    expect(existsSync(home)).toBe(false)
  })

  it("passes through when neither COGPIT_BROWSER_HOME nor HOME is set", () => {
    const env = { PATH: process.env.PATH ?? "" }
    const out = execFileSync("bash", [shimFile, "open", "x"], { env, encoding: "utf8" })
    expect(out).toContain("PROFILE=\n")
    expect(out.endsWith("[open][x]")).toBe(true)
  })

  it("uses an explicit COGPIT_BROWSER_HOME even without HOME", () => {
    const env = { PATH: process.env.PATH ?? "", COGPIT_BROWSER_HOME: home }
    const out = execFileSync("bash", [shimFile], { env, encoding: "utf8" })
    expect(out).toContain(`PROFILE=${join(home, "profiles", "default")}\n`)
  })

  it("preserves arguments with spaces and quotes", () => {
    const run = runShim(["fill", "@e1", "hello world", 'say "hi"', "it's"])
    expect(run.argv).toBe('[fill][@e1][hello world][say "hi"][it\'s]')
  })
})

describe.skipIf(process.platform === "win32")("starting a browser's daemon", () => {
  let flightShim = ""
  let log = ""

  beforeEach(() => {
    const slow = join(fakeBinDir, "slow-start")
    writeFileSync(slow, SLOW_START_BINARY, { mode: 0o755 })
    flightShim = join(root, "flight-shim.sh")
    writeFileSync(flightShim, renderShim(slow), { mode: 0o755 })
    log = join(root, "flight.log")
    writeFileSync(log, "")
  })

  function flightEnv(name: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { HOME: root, PATH: process.env.PATH ?? "", COGPIT_BROWSER_HOME: home, FLIGHT_LOG: log, FLIGHT_NAME: name, ...extra }
  }

  it.each([
    ["a named browser", "work", ["--session", "work", "open", "x"], join("run", "shared")],
    ["a throwaway", "tmp-1", ["--session", "tmp-1", "open", "x"], join("run", "s1")],
  ])("starts one daemon for %s however many calls arrive at once", async (_label, name, args, runDir) => {
    const codes = await runAtOnce("bash", [flightShim, ...args], flightEnv(name, { COGPIT_SESSION_ID: "s1" }), 6)
    try {
      expect(codes).toEqual([0, 0, 0, 0, 0, 0])
      expect(logged(log, "started")).toBe(1)
      expect(logged(log, "ran")).toBe(6)
      expect(existsSync(join(home, runDir, `${name}.starting`))).toBe(false)
    } finally {
      stopFakeDaemon(join(home, runDir, `${name}.pid`))
    }
  })

  it("dates every call to a throwaway, and none to a named browser, for the idle sweep", () => {
    runShim(["--session", "tmp-1", "snapshot"], { COGPIT_SESSION_ID: "s1" })
    runShim(["--session", "work", "snapshot"])
    expect(existsSync(join(home, "run", "s1", "tmp-1.used"))).toBe(true)
    expect(existsSync(join(home, "run", "shared", "work.used"))).toBe(false)
  })

  it("breaks a lock whose holder died", () => {
    const lock = join(home, "run", "shared", "work.starting")
    mkdirSync(lock, { recursive: true })
    const dead = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim()
    writeFileSync(join(lock, "pid"), `${dead}\n`)
    try {
      const result = spawnSync("bash", [flightShim, "--session", "work", "open", "x"], { env: flightEnv("work"), timeout: 10_000 })
      expect(result.status).toBe(0)
      expect(logged(log, "started")).toBe(1)
      expect(existsSync(lock)).toBe(false)
    } finally {
      stopFakeDaemon(join(home, "run", "shared", "work.pid"))
    }
  })
})

/** Leave the notes `server/browser/owners.ts` writes: `notes[file]` is the profile it names. */
function writeNotes(notes: Record<string, string>): void {
  mkdirSync(join(home, "owners"), { recursive: true })
  for (const [file, profile] of Object.entries(notes)) writeFileSync(join(home, "owners", file), `${profile}\n`)
}

describe.skipIf(process.platform === "win32")("shim routing of an owned default", () => {
  it("opens the session owner's profile as default, under that name everywhere", () => {
    writeNotes({ s1: "user-u_alice", ".unowned": "user-unassigned" })
    const run = runShim(["open", "x"], { COGPIT_SESSION_ID: "s1" })
    const profile = join(home, "profiles", "user-u_alice")
    expect(run.profile).toBe(profile)
    expect(run.name).toBe("user-u_alice")
    expect(run.sessionDir).toBe(join(home, "run", "shared"))
    expect(run.argv).toBe("[open][x]")
    expect(readFileSync(join(profile, ".driver"), "utf8")).toBe("s1\n")
    expect(existsSync(join(home, "profiles", "default"))).toBe(false)
  })

  it("swaps a default the call spelled, in either form, and leaves the rest alone", () => {
    writeNotes({ s1: "user-u_alice" })
    expect(runShim(["--session", "default", "open", "default"], { COGPIT_SESSION_ID: "s1" }).argv)
      .toBe("[--session][user-u_alice][open][default]")
    expect(runShim(["--session=default", "snapshot"], { COGPIT_SESSION_ID: "s1" }).argv)
      .toBe("[--session=user-u_alice][snapshot]")
    expect(runShim([], { COGPIT_SESSION_ID: "s1", AGENT_BROWSER_SESSION: "default" }).name).toBe("user-u_alice")
  })

  it("sends an agent no note names to the unowned profile", () => {
    writeNotes({ ".unowned": "user-unassigned" })
    expect(runShim([], { COGPIT_SESSION_ID: "s2" }).profile).toBe(join(home, "profiles", "user-unassigned"))
    // A process serving many sessions passes an id that is not one.
    expect(runShim([], { COGPIT_SESSION_ID: "" }).profile).toBe(join(home, "profiles", "user-unassigned"))
  })

  it("leaves Cogpit's own calls, which unset the id, on the host's default", () => {
    writeNotes({ s1: "user-u_alice", ".unowned": "user-unassigned" })
    const run = runShim(["--session", "default", "open", "about:blank"])
    expect(run.profile).toBe(join(home, "profiles", "default"))
    expect(run.name).toBe("")
    expect(run.argv).toBe("[--session][default][open][about:blank]")
  })

  it("keeps the host's default without notes, as personal edition always is", () => {
    expect(runShim([], { COGPIT_SESSION_ID: "s1" }).profile).toBe(join(home, "profiles", "default"))
  })

  it("never lets a note send default into a throwaway, itself, or outside the tree", () => {
    for (const note of ["tmp-x", "default", "../escape", "Upper", ""]) {
      writeNotes({ s1: note })
      expect(runShim([], { COGPIT_SESSION_ID: "s1" }).profile, note).toBe(join(home, "profiles", "default"))
    }
  })

  it("leaves named and throwaway browsers where they were", () => {
    writeNotes({ s1: "user-u_alice", ".unowned": "user-unassigned" })
    expect(runShim(["--session", "github"], { COGPIT_SESSION_ID: "s1" }).profile).toBe(join(home, "profiles", "github"))
    expect(runShim(["--session", "tmp-1"], { COGPIT_SESSION_ID: "s1" }).sessionDir).toBe(join(home, "run", "s1"))
  })
})

// Native Windows does not execute the POSIX browser shim or implement its mode bits.
describe.skipIf(process.platform === "win32")("shim routing with a visible browser", () => {
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  const HEADED_ARGS = "--remote-debugging-port=0,--disable-blink-features=AutomationControlled"

  function shimFor(platform: NodeJS.Platform): string {
    const file = join(root, `visible-${platform}.sh`)
    writeFileSync(file, renderShim(fakeBinary, { visibleBrowser: chrome, platform }), { mode: 0o755 })
    return file
  }

  it("keeps named browsers headless by default even when a window could open", () => {
    const run = runShim(["--session", "github", "open", "x"], {}, shimFor("darwin"))
    expect(run.headed).toBe("")
    expect(run.executable).toBe("")
    expect(run.args).toBe("--remote-debugging-port=0")
    expect(run.profile).toBe(join(home, "profiles", "github"))
  })

  it("opens a window on macOS when COGPIT_BROWSER_HEADED asks for one, with automation signalling off", () => {
    const run = runShim(["--session", "github", "open", "x"], { COGPIT_BROWSER_HEADED: "1" }, shimFor("darwin"))
    expect(run.headed).toBe("1")
    expect(run.executable).toBe(chrome)
    expect(run.args).toBe(HEADED_ARGS)
    expect(run.profile).toBe(join(home, "profiles", "github"))
  })

  it("keeps tmp-* browsers headless and unmanaged even when a window is asked for", () => {
    const run = runShim(["--session", "tmp-1", "open", "x"], { COGPIT_BROWSER_HEADED: "1" }, shimFor("darwin"))
    expect(run.headed).toBe("")
    expect(run.executable).toBe("")
    expect(run.args).toBe("")
  })

  it("stays headless on Linux without a display", () => {
    const run = runShim(["open", "x"], { COGPIT_BROWSER_HEADED: "1" }, shimFor("linux"))
    expect(run.headed).toBe("")
    expect(run.executable).toBe("")
    expect(run.args).toBe("--remote-debugging-port=0")
  })

  it.each([
    ["DISPLAY", { DISPLAY: ":0" }],
    ["WAYLAND_DISPLAY", { WAYLAND_DISPLAY: "wayland-0" }],
  ])("opens a window on Linux when asked and %s is set", (_label, env) => {
    const run = runShim(["open", "x"], { COGPIT_BROWSER_HEADED: "1", ...env }, shimFor("linux"))
    expect(run.headed).toBe("1")
    expect(run.executable).toBe(chrome)
    expect(run.args).toBe(HEADED_ARGS)
  })

  it("stays headless on Linux with a display when no window is asked for", () => {
    const run = runShim(["open", "x"], { DISPLAY: ":0" }, shimFor("linux"))
    expect(run.headed).toBe("")
    expect(run.args).toBe("--remote-debugging-port=0")
  })

  it("stays headless when asked for a window but no visible browser was found", () => {
    const run = runShim(["open", "x"], { COGPIT_BROWSER_HEADED: "1" })
    expect(run.headed).toBe("")
    expect(run.executable).toBe("")
    expect(run.args).toBe("--remote-debugging-port=0")
  })

  it("escapes the browser path like the real binary", () => {
    const script = renderShim(fakeBinary, { visibleBrowser: '/x/y "z" $HOME', platform: "darwin" })
    expect(script).toContain('export AGENT_BROWSER_EXECUTABLE_PATH="/x/y \\"z\\" \\$HOME"')
  })
})

describe("findVisibleBrowser", () => {
  it("finds Google Chrome in an Applications folder on macOS", () => {
    // /Applications comes first and may hold a real Chrome on the machine running this.
    const chrome = join(root, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome")
    mkdirSync(join(chrome, ".."), { recursive: true })
    writeFileSync(chrome, "#!/bin/sh\n", { mode: 0o755 })
    const found = findVisibleBrowser({ HOME: root, PATH: "" }, "darwin")
    expect([chrome, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]).toContain(found)
  })

  it.skipIf(process.platform === "win32")("finds a Chrome or Chromium on PATH on Linux", () => {
    const dir = join(root, "linux-bin")
    mkdirSync(dir)
    const chromium = join(dir, "chromium")
    writeFileSync(chromium, "#!/bin/sh\n", { mode: 0o755 })
    expect(findVisibleBrowser({ HOME: root, PATH: dir }, "linux")).toBe(chromium)
  })

  it("returns null when nothing is installed", () => {
    expect(findVisibleBrowser({ HOME: root, PATH: join(root, "nowhere") }, "linux")).toBeNull()
    expect(findVisibleBrowser({ HOME: root, PATH: "" }, "win32")).toBeNull()
  })
})

// On Windows ensureShim installs a .cmd launcher and a node shim instead of
// the bash script, covered by index.test.ts; the bash assertions are POSIX-only.
describe("ensureShim", () => {
  /** Backdates the shim's mtime by a minute and returns the stored value. */
  function ageShim(): number {
    const old = new Date(Date.now() - 60_000)
    utimesSync(shimPath(), old, old)
    return statSync(shimPath()).mtimeMs
  }

  it("returns null and leaves nothing behind when there is no real binary", () => {
    expect(ensureShim(null)).toEqual({ path: null })
    expect(existsSync(shimPath())).toBe(false)
  })

  it.skipIf(process.platform === "win32")("writes an executable shim inside binDir()", () => {
    expect(ensureShim(fakeBinary)).toEqual({ path: shimPath() })
    expect(shimPath().startsWith(binDir())).toBe(true)
    expect(() => accessSync(shimPath(), fsConstants.X_OK)).not.toThrow()
    if (process.platform !== "win32") expect(statSync(shimPath()).mode & 0o111).toBe(0o111)
    expect(readFileSync(shimPath(), "utf8")).toBe(renderShim(fakeBinary))
  })

  it.skipIf(process.platform === "win32")("produces a shim that routes like the rendered script", () => {
    ensureShim(fakeBinary)
    const env = { HOME: root, PATH: process.env.PATH ?? "", COGPIT_BROWSER_HOME: home }
    const out = execFileSync(shimPath(), ["open", "z"], { env, encoding: "utf8" })
    expect(out).toContain(`PROFILE=${join(home, "profiles", "default")}`)
    expect(out.endsWith("[open][z]")).toBe(true)
  })

  it("leaves a current shim untouched on repeated calls", () => {
    ensureShim(fakeBinary)
    const old = ageShim()
    ensureShim(fakeBinary)
    expect(statSync(shimPath()).mtimeMs).toBe(old)
  })

  it.skipIf(process.platform === "win32")("repairs a lost execute bit without rewriting", () => {
    ensureShim(fakeBinary)
    chmodSync(shimPath(), 0o644)
    const old = ageShim()
    ensureShim(fakeBinary)
    if (process.platform !== "win32") expect(statSync(shimPath()).mode & 0o111).toBe(0o111)
    expect(statSync(shimPath()).mtimeMs).toBe(old)
  })

  it.skipIf(process.platform === "win32")("leaves no temp file behind", () => {
    ensureShim(fakeBinary)
    expect(readdirSync(binDir())).toEqual(["agent-browser"])
  })

  it.skipIf(process.platform === "win32")("rewrites a shim whose version line differs", () => {
    mkdirSync(binDir(), { recursive: true })
    writeFileSync(shimPath(), "#!/usr/bin/env bash\n# cogpit-shim v0 — old\nexit 1\n", { mode: 0o755 })
    ensureShim(fakeBinary)
    expect(readFileSync(shimPath(), "utf8")).toBe(renderShim(fakeBinary))
  })

  it.skipIf(process.platform === "win32")("rewrites a shim that points at a different real binary", () => {
    ensureShim("/old/agent-browser")
    ensureShim("/new/agent-browser")
    expect(readFileSync(shimPath(), "utf8")).toBe(renderShim("/new/agent-browser"))
  })

  it.skipIf(process.platform === "win32")("rewrites a shim when the visible browser changes", () => {
    ensureShim(fakeBinary)
    const options = { visibleBrowser: "/opt/chrome", platform: "linux" as const }
    ensureShim(fakeBinary, options)
    expect(readFileSync(shimPath(), "utf8")).toBe(renderShim(fakeBinary, options))
  })

  it("removes an existing shim when the real binary disappears", () => {
    ensureShim(fakeBinary)
    expect(ensureShim(null)).toEqual({ path: null })
    expect(existsSync(shimPath())).toBe(false)
  })
})

describe("findRealAgentBrowser", () => {
  it.skipIf(process.platform === "win32")("skips binDir() and returns the first executable agent-browser", () => {
    ensureShim(fakeBinary)
    const env = { PATH: [binDir(), fakeBinDir].join(delimiter) }
    expect(findRealAgentBrowser(env)).toBe(fakeBinary)
  })

  it.skipIf(process.platform === "win32")("treats binDir() spelled differently as the same directory", () => {
    ensureShim(fakeBinary)
    const env = { PATH: [`${binDir()}/`, `${home}/../bin`, fakeBinDir].join(delimiter) }
    expect(findRealAgentBrowser(env)).toBe(fakeBinary)
  })

  it.skipIf(process.platform === "win32")("treats a symlink to binDir() as the same directory", () => {
    ensureShim(fakeBinary)
    const link = join(root, "link-bin")
    symlinkSync(binDir(), link)
    const env = { PATH: [link, fakeBinDir].join(delimiter) }
    expect(findRealAgentBrowser(env)).toBe(fakeBinary)
  })

  it.skipIf(process.platform === "win32")("skips a directory named agent-browser", () => {
    const dirBin = join(root, "dir-bin")
    mkdirSync(join(dirBin, "agent-browser"), { recursive: true })
    const env = { PATH: [dirBin, fakeBinDir].join(delimiter) }
    expect(findRealAgentBrowser(env)).toBe(fakeBinary)
  })

  it.skipIf(process.platform === "win32")("ignores empty entries and non-executable candidates", () => {
    const plainDir = join(root, "plain")
    mkdirSync(plainDir)
    writeFileSync(join(plainDir, "agent-browser"), "not runnable", { mode: 0o644 })
    const env = { PATH: ["", plainDir, join(root, "missing"), fakeBinDir, ""].join(delimiter) }
    expect(findRealAgentBrowser(env)).toBe(fakeBinary)
  })

  it("returns null when nothing on PATH qualifies", () => {
    ensureShim(fakeBinary)
    expect(findRealAgentBrowser({ PATH: binDir() })).toBeNull()
    expect(findRealAgentBrowser({ PATH: "" })).toBeNull()
    expect(findRealAgentBrowser({})).toBeNull()
  })
})
