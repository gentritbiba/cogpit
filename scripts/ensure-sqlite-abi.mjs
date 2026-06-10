#!/usr/bin/env node
// Ensures better-sqlite3's native binary matches the runtime ABI before
// `bun run dev` / `bun run test` / `bun run electron:dev` launch.
//
// Why this exists: `postinstall` runs `electron-builder install-app-deps`,
// which rebuilds better-sqlite3 for Electron's ABI (143). But the dev server
// (Vite) and the test runner (Vitest) execute under Node (ABI 137), so the
// Electron-built binary fails to load and full-text search dies + the
// search-index tests fail. This guard rebuilds it for the current Node ABI.
//
// The reverse also happens: after `bun run dev`/`test` rebuild for Node,
// `electron:dev` can't load the Node-built binary. `--electron` mode checks
// the binary under Electron's ABI (by re-running this script with
// ELECTRON_RUN_AS_NODE=1 and `--check-only`) and rebuilds via
// `electron-builder install-app-deps` on mismatch.
//
// Must run under NODE, never bun: bun segfaults loading this native module.
// The dev/test scripts invoke it as `node scripts/ensure-sqlite-abi.mjs`.

import { createRequire } from "node:module"
import { execSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { rmSync } from "node:fs"
import { dirname, join } from "node:path"

const require = createRequire(import.meta.url)
const selfPath = fileURLToPath(import.meta.url)

// @electron/rebuild drops a .forge-meta marker next to the binary and skips
// the rebuild when it's present — but `npm rebuild` (the node direction)
// replaces the binary without touching the marker, leaving it stale. Remove
// it so the next electron-direction rebuild actually runs.
function clearForgeMeta() {
  try {
    const pkgDir = dirname(require.resolve("better-sqlite3/package.json"))
    rmSync(join(pkgDir, "build", "Release", ".forge-meta"), { force: true })
  } catch {
    // best effort
  }
}

function tryLoad() {
  try {
    const Database = require("better-sqlite3")
    const db = new Database(":memory:")
    db.close()
    return null
  } catch (err) {
    return err
  }
}

const args = process.argv.slice(2)

if (args.includes("--check-only")) {
  // Used by --electron mode: just report whether the binary loads here.
  process.exit(tryLoad() ? 1 : 0)
}

if (args.includes("--electron")) {
  let electronBin
  try {
    electronBin = require("electron") // resolves to the binary path
  } catch {
    console.error("[ensure-sqlite-abi] electron not installed — skipping check.")
    process.exit(0)
  }

  const check = spawnSync(electronBin, [selfPath, "--check-only"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "ignore",
  })
  if (check.status === 0) process.exit(0) // already matches Electron's ABI

  console.error(
    "[ensure-sqlite-abi] better-sqlite3 won't load under Electron — rebuilding via electron-builder install-app-deps…"
  )
  try {
    clearForgeMeta()
    execSync("npx electron-builder install-app-deps", { stdio: "inherit" })
    console.error("[ensure-sqlite-abi] rebuild complete.")
  } catch {
    // Non-fatal: the electron server guards the search-index boot.
    console.error(
      "[ensure-sqlite-abi] rebuild failed — full-text search will be unavailable. Run `npx electron-builder install-app-deps` manually."
    )
  }
  process.exit(0)
}

// Probe in a child process: on Apple Silicon, loading a native module with a
// bad code signature SIGKILLs the process outright (no catchable error), so
// an in-process tryLoad() would take this guard down with it.
const probe = spawnSync(process.execPath, [selfPath, "--check-only"], { stdio: "ignore" })
if (probe.status === 0) process.exit(0) // already matches the current ABI — fast no-op

console.error(
  `[ensure-sqlite-abi] better-sqlite3 won't load under node ${process.version} (ABI ${process.versions.modules})` +
    (probe.signal ? ` (probe killed by ${probe.signal})` : "")
)
console.error("[ensure-sqlite-abi] rebuilding better-sqlite3 for the current runtime…")

try {
  execSync("npm rebuild better-sqlite3", { stdio: "inherit" })
  console.error("[ensure-sqlite-abi] rebuild complete.")
} catch {
  // Non-fatal: the search index degrades gracefully (api-plugin / electron
  // server both guard the boot). Let dev/test proceed; only search is lost.
  console.error(
    "[ensure-sqlite-abi] rebuild failed — full-text search will be unavailable. Run `npm rebuild better-sqlite3` manually."
  )
}
process.exit(0)
