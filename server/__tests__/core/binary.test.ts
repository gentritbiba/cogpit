// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CORE_BINARY_NAME, CoreBinaryMissingError, resolveCoreBinary } from "../../core/binary"

const roots: string[] = []

function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "cogpit-core-bin-"))
  roots.push(root)
  mkdirSync(join(root, "crates", "cogpit-core"), { recursive: true })
  writeFileSync(join(root, "crates", "cogpit-core", "Cargo.toml"), "")
  mkdirSync(join(root, "server", "core"), { recursive: true })
  return root
}

function build(targetDir: string, profile: string, mtime: number): string {
  const path = join(targetDir, profile, CORE_BINARY_NAME)
  mkdirSync(join(targetDir, profile), { recursive: true })
  writeFileSync(path, "")
  utimesSync(path, mtime, mtime)
  return path
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("resolveCoreBinary", () => {
  it("prefers COGPIT_CORE_BIN, then the shell's packaged path", () => {
    const root = checkout()
    const explicit = build(join(root, "elsewhere"), "bin", 1)
    const packaged = build(join(root, "packaged"), "bin", 1)
    build(join(root, "target"), "debug", 1)
    const from = join(root, "server", "core")
    expect(resolveCoreBinary({ env: { COGPIT_CORE_BIN: explicit }, configured: packaged, from })).toBe(explicit)
    expect(resolveCoreBinary({ env: {}, configured: packaged, from })).toBe(packaged)
  })

  it("finds the newest dev build from anywhere below the checkout", () => {
    const root = checkout()
    build(join(root, "target"), "debug", 1_000)
    const release = build(join(root, "target"), "release", 2_000)
    expect(resolveCoreBinary({ env: {}, from: join(root, "server", "core") })).toBe(release)
    const debug = build(join(root, "target"), "debug", 3_000)
    expect(resolveCoreBinary({ env: {}, from: join(root, "server", "core") })).toBe(debug)
  })

  it("honors CARGO_TARGET_DIR", () => {
    const root = checkout()
    const shared = mkdtempSync(join(tmpdir(), "cogpit-core-target-"))
    roots.push(shared)
    const binary = build(shared, "debug", 1)
    expect(resolveCoreBinary({ env: { CARGO_TARGET_DIR: shared }, from: root })).toBe(binary)
  })

  it("explains what is missing", () => {
    const root = checkout()
    expect(() => resolveCoreBinary({ env: {}, from: root })).toThrow(CoreBinaryMissingError)
    expect(() => resolveCoreBinary({ env: {}, from: root })).toThrow(/bun run build:core/)
    expect(() => resolveCoreBinary({ env: { COGPIT_CORE_BIN: join(root, "nope") }, from: root }))
      .toThrow(/COGPIT_CORE_BIN/)
    expect(() => resolveCoreBinary({ env: {}, from: tmpdir() })).toThrow(/no Cargo workspace/)
  })
})
