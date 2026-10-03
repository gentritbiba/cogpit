import { readFileSync } from "node:fs"
import { join, posix } from "node:path"
import type { ImportReference } from "./importReferences"
import { root, TEAM_EDITION_ROOT, TEAM_EDITION_UI_ENTRY } from "./sourceFiles"

/** The team edition's only way into core, so it can leave for its own repository unchanged. */
const CORE_ALIAS = "@cogpit/core/"
const TEAM_PACKAGE = "@cogpit/team"
/** The renderer's build-time name for the edition UI: the package's entry, or core's empty stub. */
const EDITION_UI_ALIAS = "@cogpit/edition-ui"
/** The one core module that loads the edition UI. */
const EDITION_UI_LOADER = "src/edition/load.ts"
/** The seam's own tests, which mock the alias to see whether it loads. */
const EDITION_SEAM_TESTS = "src/edition/__tests__/"
const RENDERER_ALIAS = "@/"

/**
 * The parts of the package, each with its own reach. The UI is bundled into
 * the browser, so it reaches neither the server nor Node; the shared contracts
 * are imported by both sides, so they reach neither.
 */
type EditionPart = "ui" | "shared" | "server" | "ui-tests" | "server-tests"

interface PartReach {
  /** What the part is called in a violation. */
  label: string
  /** Parts of the package it may import. */
  package: readonly EditionPart[]
  /** Core directories it may import through `@cogpit/core/`. */
  core: readonly string[]
  /** Bare packages: any, only those the root package.json declares, or none at all. */
  packages: "any" | "declared" | "none"
}

const REACH: Record<EditionPart, PartReach> = {
  ui: {
    label: "ui/",
    package: ["ui", "shared"],
    core: ["src/edition/", "src/components/ui/", "shared/"],
    packages: "declared",
  },
  shared: { label: "shared/", package: ["shared"], core: ["shared/"], packages: "none" },
  server: { label: "server code", package: ["server", "shared"], core: ["server/", "shared/"], packages: "any" },
  "ui-tests": { label: "tests/ui/", package: ["ui-tests", "ui", "shared"], core: ["src/", "shared/"], packages: "any" },
  "server-tests": {
    label: "tests/",
    package: ["server-tests", "server", "shared"],
    core: ["server/", "shared/"],
    packages: "any",
  },
}

/** Packages the renderer build can resolve: everything the root package.json declares. */
const DECLARED_PACKAGES: ReadonlySet<string> = (() => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  return new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }))
})()

function isInEdition(path: string): boolean {
  return path === TEAM_EDITION_ROOT || path.startsWith(`${TEAM_EDITION_ROOT}/`)
}

/**
 * Which part a repo-relative path inside the package belongs to, a file or a
 * directory; the package root is its server entry.
 */
function editionPart(path: string): EditionPart {
  const inner = path.slice(TEAM_EDITION_ROOT.length + 1)
  const within = (directory: string) => inner === directory || inner.startsWith(`${directory}/`)
  if (within("ui")) return "ui"
  if (within("shared")) return "shared"
  if (within("tests/ui")) return "ui-tests"
  if (within("tests")) return "server-tests"
  return "server"
}

function namesTeamPackage(specifier: string): boolean {
  return specifier === TEAM_PACKAGE || specifier.startsWith(`${TEAM_PACKAGE}/`)
}

function packageName(specifier: string): string {
  const segments = specifier.split("/")
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]
}

/**
 * The repo-relative path a specifier names, before any extension or index
 * resolution: a JSON file or a directory crosses the boundary as surely as a
 * module does. Besides relative paths only the tsconfig `paths` aliases name
 * one; no config sets `baseUrl`, so any other bare specifier is a package.
 */
export function repoTarget(source: string, specifier: string): string | null {
  if (specifier.startsWith(".")) return posix.join(posix.dirname(source), specifier)
  if (specifier.startsWith(RENDERER_ALIAS)) return posix.join("src", specifier.slice(RENDERER_ALIAS.length))
  if (specifier.startsWith(CORE_ALIAS)) return posix.normalize(specifier.slice(CORE_ALIAS.length))
  if (specifier === EDITION_UI_ALIAS) return TEAM_EDITION_UI_ENTRY
  if (specifier === TEAM_PACKAGE) return `${TEAM_EDITION_ROOT}/index.ts`
  if (namesTeamPackage(specifier)) return TEAM_EDITION_ROOT + specifier.slice(TEAM_PACKAGE.length)
  return null
}

/** A package or Node built-in named by a part that may not use it. */
function packageViolation(at: string, part: EditionPart, specifier: string): string | null {
  const { label, packages } = REACH[part]
  if (packages === "any") return null
  if (packages === "declared" && !specifier.startsWith("node:") && DECLARED_PACKAGES.has(packageName(specifier))) {
    return null
  }
  const allowed = packages === "declared" ? "only packages the root package.json declares" : "no packages"
  return `${at} imports ${specifier}, but the edition's ${label} may use ${allowed}`
}

/**
 * Core never imports the team edition: the server installs it at boot through
 * server/edition/load.ts, and the renderer bundles its UI only through
 * src/edition/load.ts. The edition reaches core only through `@cogpit/core/`,
 * and each part of it only as far as `REACH` allows; its tests may also use
 * core's test fixtures. `source` is repo-relative.
 */
export function editionViolation(source: string, { specifier, line }: ImportReference, isTest: boolean): string | null {
  const at = `${source}:${line}`
  if (specifier === EDITION_UI_ALIAS) {
    const loads = source === EDITION_UI_LOADER || source.startsWith(EDITION_SEAM_TESTS)
    return loads ? null : `${at} must not import ${EDITION_UI_ALIAS}; only ${EDITION_UI_LOADER} loads the edition UI`
  }
  const target = repoTarget(source, specifier)
  if (!isInEdition(source)) {
    if (namesTeamPackage(specifier) || (target !== null && isInEdition(target))) {
      return `${at} must not import the team edition; core installs it through server/edition/load.ts`
    }
    if (specifier.startsWith(CORE_ALIAS)) {
      return `${at} imports through ${CORE_ALIAS}, which only the team edition uses; import relatively`
    }
    return null
  }
  const part = editionPart(source)
  const reach = REACH[part]
  if (target === null) return packageViolation(at, part, specifier)
  if (!specifier.startsWith(CORE_ALIAS)) {
    if (!isInEdition(target)) return `${at} must import core through ${CORE_ALIAS}, not ${specifier}`
    const targetPart = editionPart(target)
    if (reach.package.includes(targetPart)) return null
    return `${at} must not import the edition's ${REACH[targetPart].label} from its ${reach.label}: ${specifier}`
  }
  if (!reach.core.some((prefix) => target.startsWith(prefix))) {
    return `${at} may import only core's ${reach.core.join(", ")} from the edition's ${reach.label}: ${specifier}`
  }
  if (!isTest && target.split("/").includes("__tests__")) {
    return `${at} must not import core test code: ${specifier}`
  }
  return null
}
