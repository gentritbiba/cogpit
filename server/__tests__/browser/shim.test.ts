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

function spawnShim(file: string, args: string[], extraEnv: Record<string, string> = {}) {
  const env = { HOME: root, PATH: process.env.PATH ?? "", COGPIT_BROWSER_HOME: home, ...extraEnv }
  return spawnSync("bash", [file, ...args], { env, encoding: "utf8", timeout: 5_000 })
}

function runShim(args: string[], extraEnv: Record<string, string> = {}): ShimRun {
  const result = spawnShim(shimFile, args, extraEnv)
  if (result.status !== 0) throw new Error(`shim exited ${result.status}: ${result.stderr}`)
  const [sessionDir, profile, argLine, argv = ""] = result.stdout.split("\n")
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

  it("leaves a current shim untouched on repeated calls", () => {
    ensureShim(fakeBinary)
    const old = ageShim()
    ensureShim(fakeBinary)
    expect(statSync(shimPath()).mtimeMs).toBe(old)
  })

  it("repairs a lost execute bit without rewriting", () => {
    ensureShim(fakeBinary)
    chmodSync(shimPath(), 0o644)
    const old = ageShim()
    ensureShim(fakeBinary)
    expect(statSync(shimPath()).mode & 0o111).toBe(0o111)
    expect(statSync(shimPath()).mtimeMs).toBe(old)
  })

  it("leaves no temp file behind", () => {
    ensureShim(fakeBinary)
    expect(readdirSync(binDir())).toEqual(["agent-browser"])
  })

  it("rewrites a shim whose version line differs", () => {
    mkdirSync(binDir(), { recursive: true })
    writeFileSync(shimPath(), "#!/usr/bin/env bash\n# cogpit-shim v0 — old\nexit 1\n", { mode: 0o755 })
    ensureShim(fakeBinary)
    expect(readFileSync(shimPath(), "utf8")).toBe(renderShim(fakeBinary))
  })

  it("rewrites a shim that points at a different real binary", () => {
    ensureShim("/old/agent-browser")
    ensureShim("/new/agent-browser")
    expect(readFileSync(shimPath(), "utf8")).toBe(renderShim("/new/agent-browser"))
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
    const env = { PATH: [`${binDir()}/`, `${home}/../bin`, fakeBinDir].join(delimiter) }
    expect(findRealAgentBrowser(env)).toBe(fakeBinary)
  })

  it("treats a symlink to binDir() as the same directory", () => {
    ensureShim(fakeBinary)
    const link = join(root, "link-bin")
    symlinkSync(binDir(), link)
    const env = { PATH: [link, fakeBinDir].join(delimiter) }
    expect(findRealAgentBrowser(env)).toBe(fakeBinary)
  })

  it("skips a directory named agent-browser", () => {
    const dirBin = join(root, "dir-bin")
    mkdirSync(join(dirBin, "agent-browser"), { recursive: true })
    const env = { PATH: [dirBin, fakeBinDir].join(delimiter) }
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
