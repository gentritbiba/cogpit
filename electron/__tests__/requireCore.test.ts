// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

type AfterPack = (context: {
  appOutDir: string
  electronPlatformName: string
  packager: { getResourcesDir(appOutDir: string): string }
}) => void

const hookPath = fileURLToPath(new URL("../../build/requireCore.mjs", import.meta.url))
const { default: requireCore } = await import(/* @vite-ignore */ hookPath) as { default: AfterPack }

let appOutDir: string
const packager = { getResourcesDir: (out: string) => join(out, "resources") }
const pack = (electronPlatformName: string) => requireCore({ appOutDir, electronPlatformName, packager })

function writeCore(name: string, mode: number): void {
  mkdirSync(join(appOutDir, "resources", "bin"), { recursive: true })
  writeFileSync(join(appOutDir, "resources", "bin", name), "core", { mode })
  chmodSync(join(appOutDir, "resources", "bin", name), mode)
}

beforeEach(() => { appOutDir = mkdtempSync(join(tmpdir(), "cogpit-require-core-")) })
afterEach(() => rmSync(appOutDir, { recursive: true, force: true }))

describe("electron-builder's afterPack core check", () => {
  it("refuses a package without cogpit-core", () => {
    expect(() => pack("darwin")).toThrow("cogpit-core is missing")
    expect(() => pack("win32")).toThrow("cogpit-core is missing")
  })

  it("accepts the executable core in resources/bin", () => {
    writeCore("cogpit-core", 0o755)
    expect(() => pack("linux")).not.toThrow()
  })

  it("looks for cogpit-core.exe on Windows", () => {
    writeCore("cogpit-core", 0o755)
    expect(() => pack("win32")).toThrow("cogpit-core.exe")
    writeCore("cogpit-core.exe", 0o644)
    expect(() => pack("win32")).not.toThrow()
  })

  it.skipIf(process.platform === "win32")("refuses a core that cannot run", () => {
    writeCore("cogpit-core", 0o644)
    expect(() => pack("darwin")).toThrow("cannot run")
  })
})
