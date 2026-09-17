// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireUpdate, appProcessIds, applyWhenClosed, installApp, readJob, resolveAppPath, updateDirectory, validateApp, writeJob, type LocalUpdateJob } from "../../scripts/lib/localUpdate.ts"

let root: string
let job: LocalUpdateJob

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cogpit-local-update-test-")))
  const appPath = join(root, "Cogpit.app")
  const directory = acquireUpdate(appPath)
  job = { format: 1, appPath, stagedApp: join(directory, "build/mac/Cogpit.app"), pid: process.pid, status: "building", relaunch: false }
  writeJob(job)
  mkdirSync(appPath)
  writeFileSync(join(appPath, "old-only"), "old")
  mkdirSync(job.stagedApp, { recursive: true })
  writeFileSync(join(job.stagedApp, "new-only"), "new")
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("local update process detection", () => {
  it("includes the app and its helpers without matching other installations or command arguments", () => {
    const app = "/Users/me/Applications with spaces/Cogpit.app"
    const listing = `
      10 ${app}/Contents/MacOS/Cogpit
      11 ${app}/Contents/Frameworks/Cogpit Helper.app/Contents/MacOS/Cogpit Helper
      12 ${app}.backup/Contents/MacOS/Cogpit
      13 /Applications/Cogpit.app/Contents/MacOS/Cogpit
      14 /bin/echo ${app}/Contents/MacOS/Cogpit
      15 /usr/bin/open
    `
    expect(appProcessIds(app, listing)).toEqual([10, 11])
  })

  it("requires an explicit Cogpit application destination", () => {
    expect(resolveAppPath(job.appPath)).toBe(job.appPath)
    expect(() => resolveAppPath(join(root, "Other.app"))).toThrow("Cogpit.app")
  })
})

describe("local update ownership", () => {
  it("rejects concurrent builds and preserves the queued app", () => {
    expect(() => acquireUpdate(job.appPath, () => true)).toThrow("already building")
    expect(existsSync(job.stagedApp)).toBe(true)
  })

  it("cleans up a dead builder's files on the next attempt", () => {
    acquireUpdate(job.appPath, () => false)
    expect(existsSync(job.stagedApp)).toBe(false)
    expect(readFileSync(join(job.appPath, "old-only"), "utf8")).toBe("old")
  })

  it("recovers an interrupted swap before starting another build", () => {
    renameSync(job.appPath, join(updateDirectory(job.appPath), "previous.app"))
    acquireUpdate(job.appPath, () => false)
    expect(readFileSync(join(job.appPath, "old-only"), "utf8")).toBe("old")
  })

  it("preserves both copies when the previous install's outcome is uncertain", () => {
    const backup = join(updateDirectory(job.appPath), "previous.app")
    mkdirSync(backup)
    expect(() => acquireUpdate(job.appPath, () => false)).toThrow("Both copies have been preserved")
    expect(existsSync(backup)).toBe(true)
    expect(existsSync(job.appPath)).toBe(true)
  })

  it("does not erase unrecognized or corrupt lock directories", () => {
    writeFileSync(join(updateDirectory(job.appPath), "job.json"), "{}")
    expect(() => acquireUpdate(job.appPath, () => false)).toThrow("Unrecognized update state")
    expect(existsSync(job.stagedApp)).toBe(true)
  })

  it("rejects a staged path that escapes the build directory", () => {
    writeJob({ ...job, stagedApp: join(root, "unrelated.app") })
    expect(() => readJob(job.appPath)).toThrow("Unrecognized update state")
  })
})

describe("local app replacement", () => {
  it("replaces the entire bundle and removes obsolete files and the temporary backup", () => {
    installApp(job)
    expect(readFileSync(join(job.appPath, "new-only"), "utf8")).toBe("new")
    expect(existsSync(join(job.appPath, "old-only"))).toBe(false)
    expect(existsSync(join(updateDirectory(job.appPath), "previous.app"))).toBe(false)
  })

  it("restores the installed app if moving the new bundle fails", () => {
    const rename = vi.fn<typeof renameSync>((from, to) => {
      if (from === job.stagedApp) throw new Error("disk failure")
      renameSync(from, to)
    })
    expect(() => installApp(job, { rename })).toThrow("disk failure")
    expect(readFileSync(join(job.appPath, "old-only"), "utf8")).toBe("old")
    expect(existsSync(job.stagedApp)).toBe(true)
  })

  it("restores the old bundle if macOS rejects the relaunch", () => {
    expect(() => installApp({ ...job, relaunch: true }, { launch: () => { throw new Error("launch failed") } })).toThrow("launch failed")
    expect(readFileSync(join(job.appPath, "old-only"), "utf8")).toBe("old")
    expect(readFileSync(join(job.stagedApp, "new-only"), "utf8")).toBe("new")
  })

  it("does not launch an app that was closed", () => {
    const launch = vi.fn()
    installApp(job, { launch })
    expect(launch).not.toHaveBeenCalled()
  })

  it("supports a first installation", () => {
    rmSync(job.appPath, { recursive: true })
    installApp(job)
    expect(existsSync(join(job.appPath, "new-only"))).toBe(true)
  })
})

describe("waiting for a safe install", () => {
  it("waits for the app and remaining helpers before replacing any files", async () => {
    const processes = vi.fn().mockReturnValueOnce([10, 11]).mockReturnValueOnce([11]).mockReturnValue([])
    const wait = vi.fn(async () => {
      expect(existsSync(join(job.appPath, "old-only"))).toBe(true)
      expect(readJob(job.appPath).status).toBe("waiting")
    })
    await applyWhenClosed(job, { processes, wait, validate: () => "2.6.6" })
    expect(wait).toHaveBeenCalledTimes(2)
    expect(existsSync(join(job.appPath, "new-only"))).toBe(true)
  })

  it("keeps waiting if the app reopens during bundle validation", async () => {
    const processes = vi.fn().mockReturnValueOnce([]).mockReturnValueOnce([20]).mockReturnValueOnce([20]).mockReturnValue([])
    const wait = vi.fn(async () => {})
    await applyWhenClosed(job, { processes, wait, validate: () => "2.6.6" })
    expect(wait).toHaveBeenCalledTimes(1)
    expect(existsSync(join(job.appPath, "new-only"))).toBe(true)
  })

  it("does not treat process lookup failure as proof that the app is closed", async () => {
    await expect(applyWhenClosed(job, { processes: () => { throw new Error("ps failed") } })).rejects.toThrow("ps failed")
    expect(existsSync(join(job.appPath, "old-only"))).toBe(true)
  })

  it("leaves the installed app intact when validation fails", async () => {
    await expect(applyWhenClosed(job, { processes: () => [], validate: () => { throw new Error("bad bundle") } })).rejects.toThrow("bad bundle")
    expect(existsSync(join(job.appPath, "old-only"))).toBe(true)
  })
})

it.skipIf(process.platform !== "darwin")("validates the bundle identity, executable and archive on macOS", () => {
  const contents = join(job.stagedApp, "Contents")
  mkdirSync(join(contents, "MacOS"), { recursive: true })
  mkdirSync(join(contents, "Resources"))
  writeFileSync(join(contents, "MacOS/Cogpit"), "fixture", { mode: 0o755 })
  writeFileSync(join(contents, "Resources/app.asar"), "fixture")
  const plist = (id: string) => `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>Cogpit</string><key>CFBundleShortVersionString</key><string>2.6.6</string></dict></plist>`
  writeFileSync(join(contents, "Info.plist"), plist("com.cogpit.app"))
  expect(validateApp(job.stagedApp)).toBe("2.6.6")
  writeFileSync(join(contents, "Info.plist"), plist("com.other.app"))
  expect(() => validateApp(job.stagedApp)).toThrow("not Cogpit")
})
