#!/usr/bin/env node
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const manifest = JSON.parse(readFileSync("package.json", "utf8"))
assert.equal(manifest.name, "cogpit")
assert.deepEqual(manifest.bin, { cogpit: "dist/cli.js" })
assert.equal(manifest.engines.node, ">=20.11")
assert.ok(manifest.dependencies.express)
assert.ok(manifest.dependencies["node-pty"])

const help = spawnSync(process.execPath, ["dist/cli.js", "--help"], { encoding: "utf8" })
assert.equal(help.status, 0, help.stderr)
assert.match(help.stdout, /cogpit \[options\]/i)
assert.match(help.stdout, /cogpit preview <session-id>/i)

const pack = spawnSync("npm", ["pack", "--json", "--dry-run"], { encoding: "utf8" })
assert.equal(pack.status, 0, pack.stderr)
const packResult = JSON.parse(pack.stdout)[0]
const files = packResult.files
assert.ok(files.some((file) => file.path === "dist/cli.js"))
assert.ok(files.some((file) => file.path === "dist/web/index.html"))
assert.ok(files.some((file) => file.path === "dist/web/theme-bootstrap.js"))
assert.ok(files.some((file) => file.path.startsWith("dist/web/assets/")))
assert.ok(files.some((file) => file.path === "LICENSE"))
assert.equal(files.find((file) => file.path === "dist/cli.js")?.mode, 0o755)
assert.equal(files.some((file) => file.path.includes("src/")), false)
assert.ok(packResult.unpackedSize > 1_000_000, "the compiled web app should be packaged")

const dataDir = mkdtempSync(join(tmpdir(), "cogpit-npx-contract-"))
const child = spawn(
  process.execPath,
  ["dist/cli.js", "--no-open", "--data-dir", dataDir],
  { stdio: ["ignore", "pipe", "pipe"] },
)

let stdout = ""
let stderr = ""
child.stdout.setEncoding("utf8")
child.stderr.setEncoding("utf8")
child.stdout.on("data", (chunk) => { stdout += chunk })
child.stderr.on("data", (chunk) => { stderr += chunk })

async function waitForUrl() {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 15_000) {
    const match = stdout.match(/Cogpit is running at (http:\/\/127\.0\.0\.1:\d+\/)/)
    if (match) return match[1]
    if (child.exitCode !== null) {
      throw new Error(`Cogpit exited before startup (${child.exitCode}): ${stderr}`)
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  throw new Error(`Timed out waiting for Cogpit startup. stdout=${stdout} stderr=${stderr}`)
}

try {
  const url = await waitForUrl()
  const hello = await fetch(new URL("/api/hello", url))
  assert.equal(hello.status, 200)
  const identity = await hello.json()
  assert.equal(identity.app, "cogpit")
  assert.equal(identity.mode, "standalone")
  assert.equal(identity.version, manifest.version)

  const page = await fetch(url)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<div id="root"><\/div>/)

  child.kill("SIGINT")
  const exitCode = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("Cogpit did not stop after SIGINT.")), 10_000)
    child.once("exit", (code) => {
      clearTimeout(timer)
      resolvePromise(code)
    })
  })
  assert.equal(exitCode, 0, stderr)
} finally {
  if (child.exitCode === null) child.kill("SIGKILL")
  rmSync(dataDir, { recursive: true, force: true })
}

console.log("Verified install-free Cogpit package contract")
