// @vitest-environment node
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { binDir, nodeShimPath, shimPath } from "../../browser/paths"
import {
  ensureShim,
  findRealAgentBrowser,
  renderBashLauncher,
  renderCmdLauncher,
  renderNodeShim,
  SHIM_VERSION,
} from "../../browser/shim"

/**
 * The Node shim is what Windows runs, but it is plain Node: every routing test
 * here executes it for real on the host against a fake agent-browser.
 */
const FAKE_BINARY = [
  "#!/usr/bin/env bash",
  'echo "SESSION_DIR=${AGENT_BROWSER_SOCKET_DIR:-}"',
  'echo "PROFILE=${AGENT_BROWSER_PROFILE:-}"',
  'echo "ARGS=${AGENT_BROWSER_ARGS:-}"',
  "printf '[%s]' \"$@\"",
  "",
].join("\n")

let root = ""
let home = ""
let fakeBinary = ""
let shimFile = ""
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.COGPIT_BROWSER_HOME
  root = mkdtempSync(join(tmpdir(), "cogpit-node-shim-"))
  home = join(root, "browser")
  process.env.COGPIT_BROWSER_HOME = home
  const fakeBinDir = join(root, "fake-bin")
  fakeBinary = join(fakeBinDir, "agent-browser")
  mkdirSync(fakeBinDir)
  writeFileSync(fakeBinary, FAKE_BINARY, { mode: 0o755 })
  shimFile = join(root, "shim.mjs")
  writeFileSync(shimFile, renderNodeShim(fakeBinary))
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
  argv: string
}

function spawnShim(file: string, args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [file, ...args], { env, encoding: "utf8", timeout: 10_000 })
}

function runShim(args: string[], extraEnv: Record<string, string> = {}): ShimRun {
  const env = { HOME: root, PATH: process.env.PATH ?? "", COGPIT_BROWSER_HOME: home, ...extraEnv }
  const result = spawnShim(shimFile, args, env)
  if (result.status !== 0) throw new Error(`shim exited ${result.status}: ${result.stderr}`)
  const [sessionDir, profile, argLine, argv = ""] = result.stdout.split("\n")
  return {
    sessionDir: sessionDir.replace(/^SESSION_DIR=/, ""),
    profile: profile.replace(/^PROFILE=/, ""),
    args: argLine.replace(/^ARGS=/, ""),
    argv,
  }
}

describe.skipIf(process.platform === "win32")("node shim routing", () => {
  it("carries the versioned marker line and the real binary", () => {
    const script = renderNodeShim("C:\\Users\\x\\agent-browser.exe")
    expect(script.split("\n")[0]).toMatch(new RegExp(`^// cogpit-shim v${SHIM_VERSION}\\b`))
    expect(script).toContain('const real = "C:\\\\Users\\\\x\\\\agent-browser.exe"')
  })

  it("defaults to the shared default profile with a debugging port", () => {
    const run = runShim([], { COGPIT_SESSION_ID: "s1" })
    const profile = join(home, "profiles", "default")
    expect(run.profile).toBe(profile)
    expect(run.sessionDir).toBe(join(home, "run", "shared"))
    expect(run.args).toBe("--remote-debugging-port=0")
    expect(run.argv).toBe("[]")
    expect(statSync(profile).isDirectory()).toBe(true)
    expect(readFileSync(join(profile, ".driver"), "utf8")).toBe("s1\n")
  })

  it("writes an empty .driver when no Cogpit session drives it", () => {
    runShim([])
    expect(readFileSync(join(home, "profiles", "default", ".driver"), "utf8")).toBe("\n")
  })

  it("routes --session <name> into that profile and passes arguments through", () => {
    const run = runShim(["--session", "github", "open", "x"])
    expect(run.profile).toBe(join(home, "profiles", "github"))
    expect(run.sessionDir).toBe(join(home, "run", "shared"))
    expect(run.argv).toBe("[--session][github][open][x]")
  })

  it("gives tmp-* sessions a per-session socket dir and no profile", () => {
    const run = runShim(["--session=tmp-abc", "snapshot"], { COGPIT_SESSION_ID: "s1" })
    expect(run.sessionDir).toBe(join(home, "run", "s1"))
    expect(run.profile).toBe("")
    expect(run.args).toBe("")
    expect(run.argv).toBe("[--session=tmp-abc][snapshot]")
    expect(existsSync(join(home, "profiles"))).toBe(false)
  })

  it("falls back to the shared socket dir for tmp-* without a valid session id", () => {
    expect(runShim(["--session", "tmp-1"]).sessionDir).toBe(join(home, "run", "shared"))
    expect(runShim(["--session", "tmp-1"], { COGPIT_SESSION_ID: "../x" }).sessionDir).toBe(join(home, "run", "shared"))
  })

  it("honours AGENT_BROWSER_SESSION when no flag is given, and the flag over it", () => {
    expect(runShim(["open", "y"], { AGENT_BROWSER_SESSION: "work" }).profile).toBe(join(home, "profiles", "work"))
    expect(runShim(["--session", "flag"], { AGENT_BROWSER_SESSION: "env" }).profile).toBe(join(home, "profiles", "flag"))
  })

  it.each(["Bad Name", "Foo", "-foo", "a".repeat(41)])("passes the invalid name %j through untouched", (name) => {
    const run = runShim(["--session", name, "open", "x"])
    expect(run.sessionDir).toBe("")
    expect(run.profile).toBe("")
    expect(run.argv).toBe(`[--session][${name}][open][x]`)
    expect(existsSync(home)).toBe(false)
  })

  it("keeps the default name when --session is the last argument", () => {
    const run = runShim(["--session"])
    expect(run.profile).toBe(join(home, "profiles", "default"))
    expect(run.argv).toBe("[--session]")
  })

  it("refuses to run when the real binary is missing", () => {
    const broken = join(root, "broken.mjs")
    writeFileSync(broken, renderNodeShim(join(root, "missing", "agent-browser")))
    const result = spawnShim(broken, ["open", "x"], { HOME: root, PATH: process.env.PATH ?? "", COGPIT_BROWSER_HOME: home })
    expect(result.status).toBe(127)
    expect(result.stderr).toContain("restart Cogpit")
    expect(existsSync(home)).toBe(false)
  })

  it("refuses to run when the real binary is the shim itself", () => {
    const self = join(root, "self.mjs")
    writeFileSync(self, renderNodeShim(self))
    const result = spawnShim(self, ["open", "x"], { HOME: root, PATH: process.env.PATH ?? "", COGPIT_BROWSER_HOME: home })
    expect(result.status).toBe(127)
    expect(result.stderr).toContain("restart Cogpit")
  })

  it("passes through when neither COGPIT_BROWSER_HOME nor a home directory is set", () => {
    const result = spawnShim(shimFile, ["open", "x"], { PATH: process.env.PATH ?? "" })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("PROFILE=\n")
    expect(result.stdout.endsWith("[open][x]")).toBe(true)
  })

  it("propagates the real binary's exit code", () => {
    const failing = join(root, "failing")
    writeFileSync(failing, "#!/usr/bin/env bash\nexit 3\n", { mode: 0o755 })
    const shim = join(root, "failing.mjs")
    writeFileSync(shim, renderNodeShim(failing))
    expect(spawnShim(shim, [], { HOME: root, PATH: process.env.PATH ?? "", COGPIT_BROWSER_HOME: home }).status).toBe(3)
  })

  it("preserves arguments with spaces and quotes", () => {
    const run = runShim(["fill", "@e1", "hello world", 'say "hi"', "it's"])
    expect(run.argv).toBe('[fill][@e1][hello world][say "hi"][it\'s]')
  })
})

describe("launchers", () => {
  it("renders a .cmd that hands its arguments to the node shim beside it", () => {
    expect(renderCmdLauncher()).toBe('@echo off\r\nnode "%~dp0agent-browser-shim.mjs" %*\r\n')
  })

  it("renders a bash delegate for Git Bash that execs the node shim beside it", () => {
    const script = renderBashLauncher()
    expect(script.split("\n")[0]).toBe("#!/usr/bin/env bash")
    expect(script).toContain(`# cogpit-shim v${SHIM_VERSION}`)
    expect(script).toContain('exec node "$(dirname "$0")/agent-browser-shim.mjs" "$@"')
  })
})

describe("ensureShim on Windows", () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" })
  })

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform })
  })

  it("names the .cmd launcher as the shim", () => {
    expect(shimPath()).toBe(join(binDir(), "agent-browser.cmd"))
    expect(nodeShimPath()).toBe(join(binDir(), "agent-browser-shim.mjs"))
  })

  it("writes the node shim, the .cmd launcher and the bash delegate", () => {
    expect(ensureShim(fakeBinary)).toEqual({ path: shimPath() })
    expect(readdirSync(binDir()).sort()).toEqual(["agent-browser", "agent-browser-shim.mjs", "agent-browser.cmd"])
    expect(readFileSync(nodeShimPath(), "utf8")).toBe(renderNodeShim(fakeBinary))
    expect(readFileSync(shimPath(), "utf8")).toBe(renderCmdLauncher())
    expect(readFileSync(join(binDir(), "agent-browser"), "utf8")).toBe(renderBashLauncher())
  })

  it("rewrites the node shim when the real binary moves", () => {
    ensureShim("C:\\old\\agent-browser.exe")
    ensureShim("C:\\new\\agent-browser.exe")
    expect(readFileSync(nodeShimPath(), "utf8")).toBe(renderNodeShim("C:\\new\\agent-browser.exe"))
  })

  it("removes all three files when the real binary disappears", () => {
    ensureShim(fakeBinary)
    expect(ensureShim(null)).toEqual({ path: null })
    expect(existsSync(binDir()) ? readdirSync(binDir()) : []).toEqual([])
  })
})

describe("findRealAgentBrowser on Windows", () => {
  const files = new Set<string>()
  const lookup = (env: NodeJS.ProcessEnv) =>
    findRealAgentBrowser(env, { platform: "win32", arch: "x64", isFile: (path) => files.has(path) })

  beforeEach(() => files.clear())

  it("prefers a native executable on PATH", () => {
    files.add("C:\\tools\\agent-browser.exe")
    expect(lookup({ PATH: "C:\\tools" })).toBe("C:\\tools\\agent-browser.exe")
  })

  it("resolves an npm .cmd shim to the native binary the package vendors beside it", () => {
    files.add("C:\\Users\\x\\AppData\\Roaming\\npm\\agent-browser.cmd")
    files.add("C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\agent-browser\\bin\\agent-browser-win32-x64.exe")
    expect(lookup({ PATH: "C:\\Users\\x\\AppData\\Roaming\\npm" }))
      .toBe("C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\agent-browser\\bin\\agent-browser-win32-x64.exe")
  })

  it("keeps a .cmd shim that has no vendored binary beside it", () => {
    files.add("C:\\pnpm\\agent-browser.cmd")
    expect(lookup({ PATH: "C:\\pnpm" })).toBe("C:\\pnpm\\agent-browser.cmd")
  })

  it("ignores the extensionless shell script npm leaves next to its shims", () => {
    files.add("C:\\npm\\agent-browser")
    expect(lookup({ PATH: "C:\\npm" })).toBeNull()
  })

  it("skips Cogpit's own bin directory", () => {
    files.add(join(binDir(), "agent-browser.cmd"))
    files.add("C:\\tools\\agent-browser.exe")
    expect(lookup({ PATH: [binDir(), "C:\\tools"].join(";") })).toBe("C:\\tools\\agent-browser.exe")
  })
})
