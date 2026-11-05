// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _resetInstallStateForTests, beginServerStart, cogpitHomeLocations, installState } from "../../lib/installState"

const POSIX = process.platform !== "win32"
/** Root reads through any mode bits, so a refused read cannot be staged as root. */
const CAN_LOCK = POSIX && process.getuid?.() !== 0

describe("install state", () => {
  let root: string
  let home: string
  let dataDir: string
  const start = (env: NodeJS.ProcessEnv = {}) => beginServerStart(dataDir, { env, home })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cogpit-install-state-"))
    home = join(root, "home")
    dataDir = join(root, "data")
    mkdirSync(home)
    _resetInstallStateForTests()
  })

  afterEach(() => {
    if (POSIX) {
      for (const path of [home, dataDir]) {
        try { chmodSync(path, 0o755) } catch { /* not there */ }
      }
    }
    rmSync(root, { recursive: true, force: true })
    _resetInstallStateForTests()
  })

  it("counts a server that never started one as an earlier install", () => {
    expect(installState()).toEqual({ freshInstall: false })
  })

  it("calls a truly empty machine a fresh install, and records it", async () => {
    expect(await start()).toEqual({ freshInstall: true })
    expect(installState()).toEqual({ freshInstall: true })
    expect(JSON.parse(readFileSync(join(dataDir, "install-state.json"), "utf-8"))).toMatchObject({ freshInstall: true })
  })

  it("keeps an earlier install whose data folder holds nothing it recognises, because ~/.cogpit was there", async () => {
    // v2.6.6 with only Codex: the data folder exists, no config was saved, no known entry was written.
    mkdirSync(dataDir)
    writeFileSync(join(dataDir, "codex-only-leftover.json"), "{}")
    mkdirSync(join(home, ".cogpit", "bin"), { recursive: true })
    expect(await start()).toEqual({ freshInstall: false })
  })

  it("stays fresh when this start is what creates ~/.cogpit", async () => {
    const decided = start()
    // Everything a server writes once it is running.
    mkdirSync(join(home, ".cogpit", "bin"), { recursive: true })
    mkdirSync(join(dataDir, "plugin-host-classification"), { recursive: true })
    expect(await decided).toEqual({ freshInstall: true })
    // Asked again in the same start, after those writes.
    expect(await start()).toEqual({ freshInstall: true })

    // And on every later start, from the record.
    _resetInstallStateForTests()
    expect(await start()).toEqual({ freshInstall: true })
  })

  it("follows the environment that moves parts of the Cogpit home", async () => {
    const browserHome = join(root, "browser-home")
    expect(cogpitHomeLocations({ COGPIT_BROWSER_HOME: browserHome }, home)).toEqual([join(home, ".cogpit"), browserHome])
    mkdirSync(browserHome)
    expect(await start({ COGPIT_BROWSER_HOME: browserHome })).toEqual({ freshInstall: false })
  })

  it("does not take the desktop shell's own browser files for earlier Cogpit data", async () => {
    mkdirSync(join(dataDir, "Local Storage"), { recursive: true })
    writeFileSync(join(dataDir, "Preferences"), "{}")
    expect(await start()).toEqual({ freshInstall: true })
  })

  it.each(["config.local.json", "session-config", "plugin-host-classification"])("keeps an install with %s an earlier one", async (entry) => {
    mkdirSync(dataDir)
    if (entry.endsWith(".json")) writeFileSync(join(dataDir, entry), "{}")
    else mkdirSync(join(dataDir, entry))
    expect(await start()).toEqual({ freshInstall: false })
  })

  it("treats a record it cannot read as an earlier install", async () => {
    mkdirSync(dataDir)
    writeFileSync(join(dataDir, "install-state.json"), "not json")
    expect(await start()).toEqual({ freshInstall: false })
    expect(JSON.parse(readFileSync(join(dataDir, "install-state.json"), "utf-8"))).toMatchObject({ freshInstall: false })
  })

  it.skipIf(!CAN_LOCK)("treats a data folder it cannot read as an earlier install", async () => {
    mkdirSync(dataDir)
    chmodSync(dataDir, 0o000)
    expect(await start()).toEqual({ freshInstall: false })
  })

  it.skipIf(!CAN_LOCK)("treats a Cogpit home it cannot look at as an earlier install", async () => {
    chmodSync(home, 0o000)
    expect(await start()).toEqual({ freshInstall: false })
  })
})
