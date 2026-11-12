// @vitest-environment node
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { load } from "js-yaml"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { artifactNames, electronManifests, onlyFile, publishedFiles, updaterManifest } from "../../../scripts/lib/releaseArtifacts"

const VERSION = "4.0.0"
const PUBLISHED = new Date("2026-11-12T10:00:00.000Z")
const UPDATE_FILES = [
  "Cogpit-4.0.0-arm64.app.tar.gz",
  "Cogpit-4.0.0-x64.app.tar.gz",
  "Cogpit-4.0.0.AppImage",
  "cogpit-4.0.0.pacman",
  "Cogpit-4.0.0-setup.exe",
]

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "cogpit-release-")) })
afterEach(() => rmSync(directory, { recursive: true, force: true }))

function writeRelease(): void {
  for (const name of UPDATE_FILES) {
    writeFileSync(join(directory, name), `contents of ${name}`)
    writeFileSync(join(directory, `${name}.sig`), `signature of ${name}\n`)
  }
  for (const name of ["Cogpit-4.0.0-arm64-mac.zip", "Cogpit-4.0.0-mac.zip"]) writeFileSync(join(directory, name), `contents of ${name}`)
}

describe("artifactNames", () => {
  it("keeps the names the Electron releases used", () => {
    expect(artifactNames("darwin", "arm64", VERSION)).toEqual({
      installer: "Cogpit-4.0.0-arm64.dmg",
      update: "Cogpit-4.0.0-arm64.app.tar.gz",
      electronUpdate: "Cogpit-4.0.0-arm64-mac.zip",
    })
    expect(artifactNames("darwin", "x64", VERSION)).toEqual({
      installer: "Cogpit-4.0.0.dmg",
      update: "Cogpit-4.0.0-x64.app.tar.gz",
      electronUpdate: "Cogpit-4.0.0-mac.zip",
    })
    expect(artifactNames("linux", "x64", VERSION)).toEqual({ update: "Cogpit-4.0.0.AppImage", pacman: "cogpit-4.0.0.pacman" })
    expect(artifactNames("win32", "x64", VERSION)).toEqual({ update: "Cogpit-4.0.0-setup.exe" })
  })

  it("names the Intel zip so the Electron updater never takes it for the Apple silicon one", () => {
    expect(artifactNames("darwin", "x64", VERSION).electronUpdate).not.toContain("-arm64-")
    expect(artifactNames("darwin", "arm64", VERSION).electronUpdate).toContain("-arm64-")
  })

  it("refuses a desktop build nobody ships", () => {
    expect(() => artifactNames("linux", "arm64", VERSION)).toThrow("x64 only")
    expect(() => artifactNames("win32", "arm64", VERSION)).toThrow("x64 only")
  })
})

describe("onlyFile", () => {
  it("finds the single matching file and refuses none or several", () => {
    expect(() => onlyFile(directory, ".dmg")).toThrow("found 0")
    writeFileSync(join(directory, "Cogpit_4.0.0_aarch64.dmg"), "")
    expect(onlyFile(directory, ".dmg")).toBe(join(directory, "Cogpit_4.0.0_aarch64.dmg"))
    writeFileSync(join(directory, "other.dmg"), "")
    expect(() => onlyFile(directory, ".dmg")).toThrow("found 2")
    expect(() => onlyFile(join(directory, "missing"), ".dmg")).toThrow("found 0")
  })
})

describe("updaterManifest", () => {
  it("lists every install's update file with its signature", () => {
    writeRelease()
    const manifest = updaterManifest(directory, VERSION, PUBLISHED)
    expect(manifest.version).toBe(VERSION)
    expect(manifest.pub_date).toBe("2026-11-12T10:00:00.000Z")
    expect(manifest.platforms).toEqual({
      "darwin-aarch64": {
        signature: "signature of Cogpit-4.0.0-arm64.app.tar.gz",
        url: "https://github.com/gentritbiba/cogpit/releases/download/v4.0.0/Cogpit-4.0.0-arm64.app.tar.gz",
      },
      "darwin-x86_64": {
        signature: "signature of Cogpit-4.0.0-x64.app.tar.gz",
        url: "https://github.com/gentritbiba/cogpit/releases/download/v4.0.0/Cogpit-4.0.0-x64.app.tar.gz",
      },
      "linux-x86_64": {
        signature: "signature of Cogpit-4.0.0.AppImage",
        url: "https://github.com/gentritbiba/cogpit/releases/download/v4.0.0/Cogpit-4.0.0.AppImage",
      },
      "linux-x86_64-pacman": {
        signature: "signature of cogpit-4.0.0.pacman",
        url: "https://github.com/gentritbiba/cogpit/releases/download/v4.0.0/cogpit-4.0.0.pacman",
      },
      "windows-x86_64": {
        signature: "signature of Cogpit-4.0.0-setup.exe",
        url: "https://github.com/gentritbiba/cogpit/releases/download/v4.0.0/Cogpit-4.0.0-setup.exe",
      },
    })
  })

  it("refuses a release with an unsigned or missing update file", () => {
    writeRelease()
    rmSync(join(directory, "cogpit-4.0.0.pacman.sig"))
    expect(() => updaterManifest(directory, VERSION, PUBLISHED)).toThrow("cogpit-4.0.0.pacman is not signed")
    writeRelease()
    rmSync(join(directory, "Cogpit-4.0.0-setup.exe"))
    expect(() => updaterManifest(directory, VERSION, PUBLISHED)).toThrow("missing Cogpit-4.0.0-setup.exe")
  })
})

describe("updaterManifest with the trusted key", () => {
  it("refuses a release signed with a key installed apps do not trust", () => {
    writeRelease()
    expect(() => updaterManifest(directory, VERSION, PUBLISHED, "bm90IGEga2V5")).toThrow("Cogpit-4.0.0-arm64.app.tar.gz: ")
  })
})

describe("electronManifests", () => {
  interface Feed { version: string; path: string; sha512: string; releaseDate: string; files: { url: string; sha512: string; size: number }[] }

  it("describes the files the Electron app's updater downloads on each platform", async () => {
    writeRelease()
    const manifests = await electronManifests(directory, VERSION, PUBLISHED)
    expect(Object.keys(manifests)).toEqual(["latest-mac.yml", "latest-linux.yml", "latest.yml"])
    const feed = (name: string) => load(manifests[name]) as Feed

    expect(feed("latest-mac.yml").files.map((file) => file.url)).toEqual(["Cogpit-4.0.0-mac.zip", "Cogpit-4.0.0-arm64-mac.zip"])
    expect(feed("latest-linux.yml").files.map((file) => file.url)).toEqual(["Cogpit-4.0.0.AppImage", "cogpit-4.0.0.pacman"])
    expect(feed("latest-linux.yml").path).toBe("Cogpit-4.0.0.AppImage")

    const windows = feed("latest.yml")
    const contents = "contents of Cogpit-4.0.0-setup.exe"
    expect(windows).toEqual({
      version: VERSION,
      files: [{
        url: "Cogpit-4.0.0-setup.exe",
        sha512: createHash("sha512").update(contents).digest("base64"),
        size: contents.length,
      }],
      path: "Cogpit-4.0.0-setup.exe",
      sha512: createHash("sha512").update(contents).digest("base64"),
      releaseDate: "2026-11-12T10:00:00.000Z",
    })
  })

  it("refuses a release without the zip the Electron updater needs", async () => {
    writeRelease()
    rmSync(join(directory, "Cogpit-4.0.0-mac.zip"))
    await expect(electronManifests(directory, VERSION, PUBLISHED)).rejects.toThrow("missing Cogpit-4.0.0-mac.zip")
  })
})

describe("publishedFiles", () => {
  it("adds the Electron updater's files only while the bridge is on", () => {
    const plain = publishedFiles(VERSION, false)
    expect(plain).toEqual([
      "Cogpit-4.0.0-arm64.app.tar.gz",
      "Cogpit-4.0.0-arm64.dmg",
      "Cogpit-4.0.0-setup.exe",
      "Cogpit-4.0.0-x64.app.tar.gz",
      "Cogpit-4.0.0.AppImage",
      "Cogpit-4.0.0.dmg",
      "cogpit-4.0.0.pacman",
      "latest.json",
    ])
    const bridged = publishedFiles(VERSION, true)
    expect(bridged.filter((name) => !plain.includes(name))).toEqual([
      "Cogpit-4.0.0-arm64-mac.zip",
      "Cogpit-4.0.0-mac.zip",
      "latest-linux.yml",
      "latest-mac.yml",
      "latest.yml",
    ])
  })
})
