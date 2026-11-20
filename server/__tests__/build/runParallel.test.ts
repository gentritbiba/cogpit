import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"

const SCRIPT = join(import.meta.dirname, "../../../scripts/run-parallel.ts")
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cogpit-run-parallel-"))
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    scripts: {
      ok: "bun -e \"console.log('ok ran')\"",
      fail: "bun -e \"console.log('fail ran'); process.exit(3)\"",
      env: "bun -e \"console.log('flavor=' + process.env.FLAVOR)\"",
    },
  }))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function run(...scripts: string[]) {
  const result = spawnSync("bun", [SCRIPT, ...scripts], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "" },
  })
  return { code: result.status, output: result.stdout + result.stderr }
}

it("runs every script and keeps each one's output together", () => {
  const { code, output } = run("ok", "env")
  expect(code).toBe(0)
  expect(output).toMatch(/── ✓ ok \([\d.]+s\)\n.*ok ran/s)
  expect(output).toContain("flavor=undefined")
})

it("fails after all have run when any script fails", () => {
  const { code, output } = run("fail", "ok")
  expect(code).toBe(1)
  expect(output).toContain("✗ fail")
  expect(output).toContain("ok ran")
  expect(output).toContain("1 of 2 failed: fail")
})

it("sets the environment assignments that lead an argument", () => {
  const { code, output } = run("FLAVOR=salty env")
  expect(code).toBe(0)
  expect(output).toContain("flavor=salty")
})
