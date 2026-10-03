/**
 * Public-clone check: does the committed HEAD pass as a clone without access
 * to the edition package would?
 *
 *   bun run check:public-clone [-- <vitest args>]
 *
 * Checks HEAD out into a temporary worktree, which leaves the editions/team
 * submodule empty, installs dependencies there, and runs lint, the checks,
 * both typechecks, the suite and both builds. Neither build may emit the
 * edition UI chunk. When this checkout has the package, its own
 * check-public-bundle tool then reads both builds for text only the package
 * uses. Uncommitted changes are not checked; commit them first.
 */
import { existsSync, readdirSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EDITION_UI_CHUNK } from "../build/manualChunks"
import { hasTeamEdition, root, TEAM_EDITION_ROOT } from "./lib/sourceFiles"

const vitestArgs = process.argv.slice(2)

const publicEnv: Record<string, string | undefined> = { ...process.env }
delete publicEnv.COGPIT_WITHOUT_TEAM
delete publicEnv.COGPIT_EXPECT_EDITION_UI

class StepFailed extends Error {}

function run(label: string, command: string[], cwd: string, env: Record<string, string | undefined> = publicEnv): void {
  console.log(`\n▶ ${label}`)
  const result = Bun.spawnSync(command, { cwd, env, stdout: "inherit", stderr: "inherit" })
  if (result.exitCode !== 0) throw new StepFailed(`${label} failed with exit code ${result.exitCode}`)
}

function editionUiChunks(assets: string): string[] {
  if (!existsSync(assets)) throw new StepFailed(`${assets} is missing; the build wrote nothing there`)
  return readdirSync(assets).filter((name) => name.startsWith(`${EDITION_UI_CHUNK}-`))
}

const checkout = await mkdtemp(join(tmpdir(), "cogpit-public-clone-"))
let failure: string | null = null
try {
  run("Check out HEAD without the submodule", ["git", "worktree", "add", "--detach", checkout, "HEAD"], root)
  if (existsSync(join(checkout, TEAM_EDITION_ROOT, "index.ts"))) {
    throw new StepFailed(`${TEAM_EDITION_ROOT} is populated in the temporary checkout`)
  }
  run("Install dependencies", ["bun", "install", "--frozen-lockfile"], checkout)
  run("Install cogpit-memory dependencies", ["bun", "install", "--frozen-lockfile"], join(checkout, "packages/cogpit-memory"))
  for (const script of ["lint", "check:architecture", "check:agents", "typecheck", "typecheck:tests"]) {
    run(script, ["bun", "run", script], checkout)
  }
  run("test", ["bun", "run", "test", ...vitestArgs], checkout)
  const absent = { ...publicEnv, COGPIT_EXPECT_EDITION_UI: "absent" }
  run("build:web", ["bun", "run", "build:web"], checkout, absent)
  run("electron:build", ["bun", "run", "electron:build"], checkout, absent)

  const builds = [join(checkout, "dist"), join(checkout, "out/renderer")]
  const leaked = builds.flatMap((build) => editionUiChunks(join(build, "assets")).map((name) => join(build, "assets", name)))
  if (leaked.length > 0) throw new StepFailed(`The public builds emitted the edition UI: ${leaked.join(", ")}`)

  if (hasTeamEdition) {
    run("Check the public builds for edition text",
      ["bun", join(root, TEAM_EDITION_ROOT, "tools/check-public-bundle.ts"), ...builds], root)
  }
} catch (error) {
  if (!(error instanceof StepFailed)) throw error
  failure = error.message
} finally {
  Bun.spawnSync(["git", "worktree", "remove", "--force", checkout], { cwd: root })
  await rm(checkout, { recursive: true, force: true })
}

if (failure) {
  console.error(`\nPublic-clone check failed: ${failure}`)
  process.exitCode = 1
} else {
  console.log("\nPublic-clone check passed.")
}
