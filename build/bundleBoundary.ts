import { relative, sep } from "node:path"
import type { Plugin, Rollup } from "vite"
import { root, TEAM_EDITION_ENTRY, TEAM_EDITION_ROOT } from "../scripts/lib/sourceFiles"
import { EDITION_UI_CHUNK, isEditionUiChunk } from "./manualChunks"

/** Code that runs only in Node, which no renderer bundle may hold. */
const SERVER_ONLY = ["server/", "electron/", `${TEAM_EDITION_ROOT}/server/`]
const EDITION_UI_ROOT = `${TEAM_EDITION_ROOT}/ui/`

type Expectation = "present" | "absent"

/** COGPIT_EXPECT_EDITION_UI: whether the build must, or must not, emit the edition UI chunk. */
function expectedEditionUi(value: string | undefined): Expectation | null {
  if (value === undefined || value === "") return null
  if (value === "present" || value === "absent") return value
  throw new Error(`COGPIT_EXPECT_EDITION_UI must be "present" or "absent", not "${value}"`)
}

/** A module id as a repo-relative path, or null for a virtual module or one outside the checkout. */
function repoPath(checkout: string, id: string): string | null {
  if (id.startsWith("\0")) return null
  const path = relative(checkout, id.split("?")[0]).split(sep).join("/")
  return path.startsWith("..") ? null : path
}

function holdsServerCode(path: string): boolean {
  return path === TEAM_EDITION_ENTRY || SERVER_ONLY.some((prefix) => path.startsWith(prefix))
}

/** Every chunk an entry chunk loads before it runs. */
function staticallyLoaded(entry: Rollup.OutputChunk, chunks: ReadonlyMap<string, Rollup.OutputChunk>): Set<string> {
  const loaded = new Set<string>()
  const pending = [...entry.imports]
  for (let fileName = pending.pop(); fileName !== undefined; fileName = pending.pop()) {
    if (loaded.has(fileName)) continue
    loaded.add(fileName)
    pending.push(...(chunks.get(fileName)?.imports ?? []))
  }
  return loaded
}

/** Every way `bundle` breaks the renderer's edition boundary. */
export function bundleViolations(
  bundle: Rollup.OutputBundle,
  expectation: Expectation | null,
  checkout = root,
): string[] {
  const chunks = new Map<string, Rollup.OutputChunk>()
  const violations: string[] = []
  for (const output of Object.values(bundle)) {
    if (output.type === "chunk") {
      chunks.set(output.fileName, output)
    } else if (output.fileName.endsWith(".map") && String(output.source).includes(TEAM_EDITION_ROOT)) {
      violations.push(`${output.fileName} maps the edition package's sources`)
    }
  }

  const editionUiChunks = [...chunks.values()].filter(isEditionUiChunk).map((chunk) => chunk.fileName)
  for (const chunk of chunks.values()) {
    for (const id of chunk.moduleIds) {
      const path = repoPath(checkout, id)
      if (path === null) continue
      if (holdsServerCode(path)) violations.push(`${chunk.fileName} holds server code: ${path}`)
      if (path.startsWith(EDITION_UI_ROOT) && !isEditionUiChunk(chunk)) {
        violations.push(`${chunk.fileName} holds edition UI outside the ${EDITION_UI_CHUNK} chunk: ${path}`)
      }
    }
    if (chunk.isEntry) {
      const loaded = staticallyLoaded(chunk, chunks)
      for (const fileName of editionUiChunks.filter((name) => loaded.has(name))) {
        violations.push(`${chunk.fileName} loads ${fileName} eagerly; the edition UI may only be imported dynamically`)
      }
    }
  }

  if (expectation === "present" && editionUiChunks.length === 0) {
    violations.push(`no ${EDITION_UI_CHUNK} chunk, but COGPIT_EXPECT_EDITION_UI=present`)
  }
  if (expectation === "absent" && editionUiChunks.length > 0) {
    violations.push(`${editionUiChunks.join(", ")} emitted, but COGPIT_EXPECT_EDITION_UI=absent`)
  }
  return violations
}

/**
 * Fails a renderer build whose bundle holds server code, whose edition UI is
 * outside its one lazy chunk or loaded by an entry, whose source maps name
 * the edition package, or whose edition UI chunk is not what
 * COGPIT_EXPECT_EDITION_UI says it must be.
 */
export function bundleBoundary(env: NodeJS.ProcessEnv = process.env): Plugin {
  const expectation = expectedEditionUi(env.COGPIT_EXPECT_EDITION_UI)
  return {
    name: "cogpit:bundle-boundary",
    apply: "build",
    generateBundle(_options, bundle) {
      const violations = bundleViolations(bundle, expectation)
      if (violations.length > 0) {
        this.error(`Renderer bundle boundary:\n${violations.map((violation) => `- ${violation}`).join("\n")}`)
      }
    },
  }
}
