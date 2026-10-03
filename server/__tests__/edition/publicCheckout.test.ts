// @vitest-environment node
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EDITION_UI_STUB, editionUiEntry } from "../../../build/editionAliases"
import {
  root,
  TEAM_EDITION_ENTRY,
  TEAM_EDITION_ROOT,
  TEAM_EDITION_UI_ENTRY,
  teamEditionIn,
} from "../../../scripts/lib/sourceFiles"

/**
 * A public clone has an empty editions/team: the private submodule is not
 * checked out. It must behave exactly like a tree without the directory.
 */
type Layout = "absent" | "empty" | "present" | "present with UI"

const LOADER = pathToFileURL(join(root, "server/edition/load.ts")).href

let checkout: string

function lay(layout: Layout): void {
  if (layout === "absent") return
  mkdirSync(join(checkout, TEAM_EDITION_ROOT), { recursive: true })
  if (layout === "empty") return
  writeFileSync(join(checkout, TEAM_EDITION_ENTRY), `export default { edition: "team" }\n`)
  if (layout === "present") return
  mkdirSync(join(checkout, TEAM_EDITION_ROOT, "ui"))
  writeFileSync(join(checkout, TEAM_EDITION_UI_ENTRY), `export default { edition: "team", ui: {} }\n`)
}

/** Boots the real loader under Bun, resolving @cogpit/team through the repo's own tsconfig path. */
function loadEditions(): { personal: string, team: string } {
  const { compilerOptions } = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf-8")) as {
    compilerOptions: { paths: Record<string, string[]> }
  }
  writeFileSync(join(checkout, "tsconfig.json"), JSON.stringify({
    compilerOptions: { paths: { "@cogpit/team": compilerOptions.paths["@cogpit/team"] } },
  }))
  writeFileSync(join(checkout, "probe.ts"), [
    `import { loadEdition } from ${JSON.stringify(LOADER)}`,
    `const importTeam = () => import("@cogpit/team")`,
    `const personal = await loadEdition({ shell: "standalone" }, importTeam)`,
    `const team = await loadEdition({ shell: "standalone", configEdition: "team" }, importTeam)`,
    `  .catch((error: Error) => error.message)`,
    `console.log(JSON.stringify({ personal, team }))`,
  ].join("\n"))
  const env = { ...process.env }
  delete env.COGPIT_EDITION
  const run = spawnSync("bun", ["probe.ts"], { cwd: checkout, env, encoding: "utf-8" })
  expect(run.stderr).toBe("")
  return JSON.parse(run.stdout) as { personal: string, team: string }
}

beforeEach(() => {
  checkout = mkdtempSync(join(tmpdir(), "cogpit-public-checkout-"))
})

afterEach(() => {
  rmSync(checkout, { recursive: true, force: true })
})

describe("an empty editions/team", () => {
  it.each(["absent", "empty"] as const)("is no team package when the directory is %s", (layout) => {
    lay(layout)
    expect(teamEditionIn(checkout)).toBe(false)
  })

  it("is a team package once its entry file is there", () => {
    lay("present")
    expect(teamEditionIn(checkout)).toBe(true)
  })

  it.each(["absent", "empty"] as const)("boots personal and refuses team when the directory is %s", (layout) => {
    lay(layout)
    expect(loadEditions()).toEqual({
      personal: "personal",
      team: "Cogpit Team is not installed in this build — set COGPIT_EDITION=personal or remove edition from config.local.json",
    })
  }, 30_000)

  it("reaches the package through the same path once its entry file is there", () => {
    lay("present")
    expect(loadEditions().team).toMatch(/^@cogpit\/team does not match this build of Cogpit; it lacks /)
  }, 30_000)
})

describe("the edition UI a build bundles", () => {
  it("falls back to a stub core ships", () => {
    expect(existsSync(join(root, EDITION_UI_STUB))).toBe(true)
  })

  it.each(["absent", "empty", "present"] as const)("is core's empty stub when editions/team is %s", (layout) => {
    lay(layout)
    expect(editionUiEntry(checkout, {})).toBe(join(checkout, EDITION_UI_STUB))
  })

  it("is the package's UI entry once the package has one", () => {
    lay("present with UI")
    expect(editionUiEntry(checkout, {})).toBe(join(checkout, TEAM_EDITION_UI_ENTRY))
  })

  it("is core's empty stub when the build runs as a public clone", () => {
    lay("present with UI")
    expect(editionUiEntry(checkout, { COGPIT_WITHOUT_TEAM: "1" })).toBe(join(checkout, EDITION_UI_STUB))
  })
})
