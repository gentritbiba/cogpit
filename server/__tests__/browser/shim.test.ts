// @vitest-environment node
import { execFileSync } from "node:child_process"
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { binDir, shimPath } from "../../browser/paths"
import { ensureShim, findRealAgentBrowser, renderShim, SHIM_VERSION } from "../../browser/shim"

const FAKE_BINARY = [
  "#!/usr/bin/env bash",
  'echo "SESSION_DIR=$AGENT_BROWSER_SOCKET_DIR"',
  'echo "PROFILE=${AGENT_BROWSER_PROFILE:-}"',
  'echo "ARGS=${AGENT_BROWSER_ARGS:-}"',
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
  argv: string
}

function runShim(args: string[], extraEnv: Record<string, string> = {}): ShimRun {
  const env = { HOME: root, PATH: process.env.PATH ?? "", COGPIT_BROWSER_HOME: home, ...extraEnv }
  const out = execFileSync("bash", [shimFile, ...args], { env, encoding: "utf8" })
  const [sessionDir, profile, argLine, argv = ""] = out.split("\n")
  return {
    sessionDir: sessionDir.replace(/^SESSION_DIR=/, ""),
    profile: profile.replace(/^PROFILE=/, ""),
    args: argLine.replace(/^ARGS=/, ""),
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

describe("shim routing", () => {
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

  it("writes an empty .driver when no Cogpit session drives it", () => {
    runShim([])
    expect(readFileSync(join(home, "profiles", "default", ".driver"), "utf8")).toBe("\n")
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

  it("preserves arguments with spaces and quotes", () => {
    const run = runShim(["fill", "@e1", "hello world", 'say "hi"', "it's"])
    expect(run.argv).toBe('[fill][@e1][hello world][say "hi"][it\'s]')
  })
})

describe("ensureShim", () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it("returns null and leaves nothing behind when there is no real binary", () => {
    expect(ensureShim(null)).toEqual({ path: null })
    expect(existsSync(shimPath())).toBe(false)
  })

  it("writes an executable shim inside binDir()", () => {
    expect(ensureShim(fakeBinary)).toEqual({ path: shimPath() })
    expect(shimPath().startsWith(binDir())).toBe(true)
    expect(() => accessSync(shimPath(), fsConstants.X_OK)).not.toThrow()
    expect(statSync(shimPath()).mode & 0o111).toBe(0o111)
    expect(readFileSync(shimPath(), "utf8")).toBe(renderShim(fakeBinary))
  })

  it("produces a shim that routes like the rendered script", () => {
    ensureShim(fakeBinary)
    const env = { HOME: root, PATH: process.env.PATH ?? "", COGPIT_BROWSER_HOME: home }
    const out = execFileSync(shimPath(), ["open", "z"], { env, encoding: "utf8" })
    expect(out).toContain(`PROFILE=${join(home, "profiles", "default")}`)
    expect(out.endsWith("[open][z]")).toBe(true)
  })

  it("leaves a current shim untouched on repeated calls", async () => {
    ensureShim(fakeBinary)
    const before = statSync(shimPath()).mtimeMs
    await wait(20)
    ensureShim(fakeBinary)
    expect(statSync(shimPath()).mtimeMs).toBe(before)
  })

  it("rewrites a shim whose version line differs", () => {
    mkdirSync(binDir(), { recursive: true })
    writeFileSync(shimPath(), "#!/usr/bin/env bash\n# cogpit-shim v0 — old\nexit 1\n", { mode: 0o755 })
    ensureShim(fakeBinary)
    expect(readFileSync(shimPath(), "utf8")).toBe(renderShim(fakeBinary))
  })

  it("removes an existing shim when the real binary disappears", () => {
    ensureShim(fakeBinary)
    expect(ensureShim(null)).toEqual({ path: null })
    expect(existsSync(shimPath())).toBe(false)
  })
})

describe("findRealAgentBrowser", () => {
  it("skips binDir() and returns the first executable agent-browser", () => {
    ensureShim(fakeBinary)
    const env = { PATH: [binDir(), fakeBinDir].join(delimiter) }
    expect(findRealAgentBrowser(env)).toBe(fakeBinary)
  })

  it("treats binDir() spelled differently as the same directory", () => {
    ensureShim(fakeBinary)
    const env = { PATH: [`${binDir()}/`, join(home, "..", "bin"), fakeBinDir].join(delimiter) }
    expect(findRealAgentBrowser(env)).toBe(fakeBinary)
  })

  it("ignores empty entries and non-executable candidates", () => {
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
