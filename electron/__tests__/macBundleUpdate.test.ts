// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { replaceableAppPath, stageDirectory, stageMacUpdate, SWAP_SCRIPT } from "../macBundleUpdate.ts"

let root: string
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "cogpit-mac-update-"))) })
afterEach(() => {
  chmodSync(root, 0o700)
  rmSync(root, { recursive: true, force: true })
})

function makeBundle(appPath: string, version: string): void {
  mkdirSync(join(appPath, "Contents/MacOS"), { recursive: true })
  mkdirSync(join(appPath, "Contents/Resources"), { recursive: true })
  writeFileSync(join(appPath, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.cogpit.app</string>
<key>CFBundleExecutable</key><string>Cogpit</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>`)
  writeFileSync(join(appPath, "Contents/MacOS/Cogpit"), "#!/bin/sh\n", { mode: 0o755 })
  writeFileSync(join(appPath, "Contents/Resources/app.asar"), version)
}

function exitedPid(): number {
  return spawnSync("/bin/sh", ["-c", "exit 0"]).pid
}

describe("replaceable app path", () => {
  it("accepts a writable bundle", () => {
    const appPath = join(root, "Cogpit.app")
    makeBundle(appPath, "3.4.1")
    expect(replaceableAppPath(join(appPath, "Contents/MacOS/Cogpit"), join(appPath, "Contents/Resources"))).toBe(appPath)
  })

  it("refuses mounted images, translocated copies and local developer builds", () => {
    expect(replaceableAppPath("/Volumes/Cogpit/Cogpit.app/Contents/MacOS/Cogpit", "/Volumes/Cogpit/Cogpit.app/Contents/Resources")).toBeNull()
    expect(replaceableAppPath("/private/var/folders/x/AppTranslocation/y/d/Cogpit.app/Contents/MacOS/Cogpit", "/tmp")).toBeNull()
    const appPath = join(root, "Cogpit.app")
    makeBundle(appPath, "3.4.1")
    writeFileSync(join(appPath, "Contents/Resources/local-build.json"), "{}")
    expect(replaceableAppPath(join(appPath, "Contents/MacOS/Cogpit"), join(appPath, "Contents/Resources"))).toBeNull()
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("refuses a bundle whose folder is not writable", () => {
    const appPath = join(root, "Cogpit.app")
    makeBundle(appPath, "3.4.1")
    chmodSync(root, 0o500)
    expect(replaceableAppPath(join(appPath, "Contents/MacOS/Cogpit"), join(appPath, "Contents/Resources"))).toBeNull()
  })
})

describe.skipIf(process.platform === "win32")("bundle swap", () => {
  it("replaces the app once its process has exited and removes the stage", () => {
    const appPath = join(root, "Cogpit.app")
    const stagedApp = join(stageDirectory(appPath), "Cogpit.app")
    makeBundle(appPath, "3.4.1")
    makeBundle(stagedApp, "3.5.0")
    execFileSync("/bin/sh", ["-c", SWAP_SCRIPT, "test", String(exitedPid()), appPath, stagedApp, "0"])
    expect(readFileSync(join(appPath, "Contents/Resources/app.asar"), "utf8")).toBe("3.5.0")
    expect(existsSync(stageDirectory(appPath))).toBe(false)
  })

  it("restores the installed app when the staged one cannot be moved into place", () => {
    const appPath = join(root, "Cogpit.app")
    makeBundle(appPath, "3.4.1")
    mkdirSync(stageDirectory(appPath))
    const result = spawnSync("/bin/sh", ["-c", SWAP_SCRIPT, "test", String(exitedPid()), appPath, join(stageDirectory(appPath), "Cogpit.app"), "0"])
    expect(result.status).toBe(1)
    expect(readFileSync(join(appPath, "Contents/Resources/app.asar"), "utf8")).toBe("3.4.1")
  })
})

describe.runIf(process.platform === "darwin")("staging a macOS update", () => {
  function archive(version: string): { bytes: Buffer; file: { url: string; sha512: string; size: number } } {
    const source = join(root, `source-${version}`)
    makeBundle(join(source, "Cogpit.app"), version)
    const zip = join(root, `${version}.zip`)
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", join(source, "Cogpit.app"), zip])
    const bytes = readFileSync(zip)
    return { bytes, file: { url: "Cogpit-mac.zip", sha512: createHash("sha512").update(bytes).digest("base64"), size: bytes.length } }
  }
  const serve = (bytes: Buffer) => (async () => new Response(bytes))

  it("downloads, verifies and extracts the bundle beside the installed app", async () => {
    const appPath = join(root, "Cogpit.app")
    makeBundle(appPath, "3.4.1")
    const { bytes, file } = archive("3.5.0")
    const staged = await stageMacUpdate(serve(bytes), appPath, "3.5.0", "https://example.test/Cogpit-mac.zip", file)
    expect(staged.stagedApp).toBe(join(stageDirectory(appPath), "Cogpit.app"))
    expect(readFileSync(join(staged.stagedApp, "Contents/Resources/app.asar"), "utf8")).toBe("3.5.0")
    expect(existsSync(join(stageDirectory(appPath), "update.zip"))).toBe(false)
  })

  it("discards an archive that holds a different version than the manifest", async () => {
    const appPath = join(root, "Cogpit.app")
    makeBundle(appPath, "3.4.1")
    const { bytes, file } = archive("3.4.9")
    await expect(stageMacUpdate(serve(bytes), appPath, "3.5.0", "https://example.test/Cogpit-mac.zip", file)).rejects.toThrow("expected 3.5.0")
    expect(existsSync(stageDirectory(appPath))).toBe(false)
  })
})
