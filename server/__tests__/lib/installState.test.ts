// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _resetInstallStateForTests, captureInstallState, installState } from "../../lib/installState"

describe("install state", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cogpit-install-state-"))
    _resetInstallStateForTests()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    _resetInstallStateForTests()
  })

  it("counts an install that was never captured as an earlier one", () => {
    expect(installState()).toEqual({ freshInstall: false })
  })

  it("records a data folder that does not exist yet as a fresh install", async () => {
    const dataDir = join(root, "data")
    expect(await captureInstallState(dataDir)).toEqual({ freshInstall: true })
    expect(installState()).toEqual({ freshInstall: true })
    expect(JSON.parse(readFileSync(join(dataDir, "install-state.json"), "utf-8"))).toMatchObject({ freshInstall: true })
  })

  it("does not take the desktop shell's own browser files for earlier Cogpit data", async () => {
    mkdirSync(join(root, "Local Storage"))
    writeFileSync(join(root, "Preferences"), "{}")
    expect(await captureInstallState(root)).toEqual({ freshInstall: true })
  })

  it("keeps an install whose user never saved a setting an earlier one", async () => {
    // An auto-detected config is never written; the server's other folders still are.
    mkdirSync(join(root, "session-config"))
    expect(await captureInstallState(root)).toEqual({ freshInstall: false })
  })

  it("keeps an install with a saved config an earlier one", async () => {
    writeFileSync(join(root, "config.local.json"), "{}")
    expect(await captureInstallState(root)).toEqual({ freshInstall: false })
  })

  it("keeps its first answer once the server has written files of its own", async () => {
    expect(await captureInstallState(root)).toEqual({ freshInstall: true })
    writeFileSync(join(root, "config.local.json"), "{}")
    mkdirSync(join(root, "session-config"))
    _resetInstallStateForTests()
    expect(await captureInstallState(root)).toEqual({ freshInstall: true })
  })

  it("decides again when the record cannot be read", async () => {
    writeFileSync(join(root, "install-state.json"), "not json")
    writeFileSync(join(root, "config.local.json"), "{}")
    expect(await captureInstallState(root)).toEqual({ freshInstall: false })
  })
})
