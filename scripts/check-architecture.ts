import { readFile } from "node:fs/promises"
import { extname, join } from "node:path"
import { editionViolation, repoTarget } from "./lib/editionBoundary"
import {
  countEditionLines,
  editionVocabularyViolations,
  isEditionVocabularyExempt,
} from "./lib/editionVocabulary"
import { extractImports } from "./lib/importReferences"
import { collectSourceRoots, hasTeamEdition, relativePath, root, TEAM_EDITION_ROOT } from "./lib/sourceFiles"

const publicPackages: Record<string, string> = {
  "@cogpit/plugin-contracts": "packages/plugin-contracts",
  "@cogpit/plugin-sdk": "packages/plugin-sdk",
  "@cogpit/plugin-ui": "packages/plugin-ui",
  "@cogpit/plugin-integrations": "packages/plugin-integrations",
  "@cogpit/plugin-tools": "packages/plugin-tools",
}
const publicExports = new Map<string, string>()
const packageDependencies = new Map<string, Set<string>>()
/** Packages that ship a CLI run under Node and may use its built-in modules. */
const nodePackages = new Set<string>()
for (const [name, directory] of Object.entries(publicPackages)) {
  const manifest = JSON.parse(await readFile(join(root, directory, "package.json"), "utf8")) as {
    exports: Record<string, string | { import: string }>
    bin?: Record<string, string>
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
  if (manifest.bin) nodePackages.add(directory)
  for (const [key, target] of Object.entries(manifest.exports)) {
    const entry = typeof target === "string" ? target : target.import
    publicExports.set(key === "." ? name : name + key.slice(1), join(root, directory, entry.replace(/^\.\/dist\//u, "src/")))
  }
  packageDependencies.set(directory, new Set(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })))
}
const sourceRoots = [
  "shared", "src", "plugins", "server", "electron", "packages/cogpit-memory/src",
  ...Object.values(publicPackages).map((path) => `${path}/src`),
  ...(hasTeamEdition ? [TEAM_EDITION_ROOT] : []),
]
const emittedExtensions = new Set([".js", ".jsx", ".mjs", ".cjs"])

interface Edge {
  source: string
  target: string
  line: number
}

function resolveLocalImport(source: string, specifier: string, files: Set<string>): string | null {
  const target = repoTarget(relativePath(source), specifier)
  const unresolved = publicExports.get(specifier) ?? (target === null ? null : join(root, target))
  if (unresolved === null) return null

  const unresolvedExtension = extname(unresolved)
  const sourceStem = emittedExtensions.has(unresolvedExtension)
    ? unresolved.slice(0, -unresolvedExtension.length)
    : unresolved
  const candidates = unresolvedExtension && !emittedExtensions.has(unresolvedExtension)
    ? [unresolved]
    : [
        `${sourceStem}.ts`,
        `${sourceStem}.tsx`,
        `${sourceStem}.mts`,
        `${sourceStem}.cts`,
        join(sourceStem, "index.ts"),
        join(sourceStem, "index.tsx"),
      ]
  return candidates.find((candidate) => files.has(candidate)) ?? null
}

type Layer = "shared" | "src" | "plugin" | "server" | "electron" | "package"

/**
 * The edition's parts sit in the core layer they extend: its UI with the
 * renderer, its contracts with shared, everything else with the server.
 */
function layer(path: string): Layer | null {
  if (path.startsWith(`${TEAM_EDITION_ROOT}/ui/`)) return "src"
  if (path.startsWith(`${TEAM_EDITION_ROOT}/shared/`)) return "shared"
  if (path.startsWith(`${TEAM_EDITION_ROOT}/`)) return "server"
  if (path.startsWith("shared/")) return "shared"
  if (path.startsWith("src/")) return "src"
  if (path.startsWith("plugins/")) return "plugin"
  if (path.startsWith("server/")) return "server"
  if (path.startsWith("electron/")) return "electron"
  if (path.startsWith("packages/")) return "package"
  return null
}

function isForbiddenCrossLayerEdge(edge: Edge): boolean {
  if (edge.source.startsWith("packages/plugin-contracts/")) {
    return !edge.target.startsWith("packages/plugin-contracts/")
  }
  for (const directory of ["packages/plugin-sdk", "packages/plugin-tools"]) {
    if (edge.source.startsWith(`${directory}/`)) return !edge.target.startsWith(`${directory}/`) && !edge.target.startsWith("packages/plugin-contracts/")
  }
  for (const directory of ["packages/plugin-ui", "packages/plugin-integrations"]) {
    if (edge.source.startsWith(`${directory}/`)) return !edge.target.startsWith(`${directory}/`)
  }
  if (edge.source.startsWith("plugins/")) {
    const ownDirectory = edge.source.split("/").slice(0, 2).join("/") + "/"
    return !edge.target.startsWith(ownDirectory) && !edge.target.startsWith("packages/plugin-")
  }
  if (edge.target.startsWith("plugins/")) return true
  const sourceLayer = layer(edge.source)
  const targetLayer = layer(edge.target)
  if (!sourceLayer || !targetLayer || sourceLayer === targetLayer) return false

  if (targetLayer === "shared") return false
  if (sourceLayer === "shared" && (edge.target.startsWith("packages/plugin-contracts/") || edge.target.startsWith("packages/plugin-integrations/"))) return false
  if (sourceLayer === "shared") return true
  if (sourceLayer === "package") return targetLayer !== "package"
  if (sourceLayer === "src") return targetLayer === "server" || targetLayer === "electron"
  if (sourceLayer === "server") return targetLayer === "src" || targetLayer === "electron"
  if (sourceLayer === "electron") return targetLayer === "src"
  return false
}

function findCycles(graph: Map<string, string[]>): string[][] {
  let index = 0
  const indices = new Map<string, number>()
  const lowLinks = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const cycles: string[][] = []

  const visit = (node: string) => {
    indices.set(node, index)
    lowLinks.set(node, index)
    index += 1
    stack.push(node)
    onStack.add(node)

    for (const target of graph.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target)
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(target)!))
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(target)!))
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return
    const component: string[] = []
    let current: string
    do {
      current = stack.pop()!
      onStack.delete(current)
      component.push(current)
    } while (current !== node)

    if (component.length > 1 || (graph.get(node) ?? []).includes(node)) {
      cycles.push(component.sort())
    }
  }

  for (const node of graph.keys()) {
    if (!indices.has(node)) visit(node)
  }
  return cycles
}

const absoluteFiles = await collectSourceRoots(sourceRoots)
const fileSet = new Set(absoluteFiles)
const edges: Edge[] = []
const violations: string[] = []

for (const source of absoluteFiles) {
  const contents = await readFile(source, "utf8")
  for (const reference of extractImports(contents, source)) {
    const localSource = relativePath(source)
    for (const [name, directory] of Object.entries(publicPackages)) {
      if (reference.specifier.startsWith(`${name}/`) && !publicExports.has(reference.specifier)) {
        violations.push(`${localSource}:${reference.line} imports a private package subpath: ${reference.specifier}`)
      }
      if (!localSource.startsWith(`${directory}/`) && reference.specifier.startsWith(".")) {
        const target = resolveLocalImport(source, reference.specifier, fileSet)
        if (target && relativePath(target).startsWith(`${directory}/`)) {
          violations.push(`${localSource}:${reference.line} must use the public ${name} export`)
        }
      }
    }
    for (const [directory, permitted] of packageDependencies) {
      if (!localSource.startsWith(`${directory}/`) || reference.specifier.startsWith(".")) continue
      if (reference.specifier.startsWith("node:") && nodePackages.has(directory)) continue
      const dependency = reference.specifier.startsWith("@") ? reference.specifier.split("/").slice(0, 2).join("/") : reference.specifier.split("/")[0]
      if (!permitted.has(dependency)) violations.push(`${localSource}:${reference.line} imports an undeclared browser dependency: ${reference.specifier}`)
    }
    const editionProblem = editionViolation(localSource, reference, false)
    if (editionProblem) violations.push(editionProblem)
    const target = resolveLocalImport(source, reference.specifier, fileSet)
    if (!target) continue
    edges.push({ source: relativePath(source), target: relativePath(target), line: reference.line })
  }
}

// Tests fall under the edition rule too: a core test that reached into the
// team edition would fail the moment a public checkout runs without it. So do
// the tooling, the build config and the npm launcher, which run there without
// joining the layers.
const everyFile = await collectSourceRoots([...sourceRoots, "scripts", "build", "packages/cogpit-cli/src"], { tests: true })
const editionVocabulary = new Map<string, number>()
for (const source of everyFile) {
  const localSource = relativePath(source)
  const contents = await readFile(source, "utf8")
  if (!fileSet.has(source)) {
    for (const reference of extractImports(contents, source)) {
      const editionProblem = editionViolation(localSource, reference, true)
      if (editionProblem) violations.push(editionProblem)
    }
  }
  if (localSource.startsWith(`${TEAM_EDITION_ROOT}/`) || isEditionVocabularyExempt(localSource)) continue
  const editionLines = countEditionLines(contents)
  if (editionLines > 0) editionVocabulary.set(localSource, editionLines)
}

// Core may not tell which edition it runs outside server/edition/.
violations.push(...editionVocabularyViolations(editionVocabulary))

for (const edge of edges) {
  if (isForbiddenCrossLayerEdge(edge)) {
    violations.push(`${edge.source}:${edge.line} must not import ${edge.target}`)
  }
}

const graph = new Map<string, string[]>()
for (const file of absoluteFiles.map(relativePath)) graph.set(file, [])
for (const edge of edges) graph.get(edge.source)?.push(edge.target)
for (const cycle of findCycles(graph)) {
  violations.push(`circular imports: ${cycle.join(" -> ")}`)
}

if (violations.length > 0) {
  console.error("Architecture check failed:\n")
  for (const violation of violations) console.error(`- ${violation}`)
  process.exitCode = 1
} else {
  console.log(`Architecture check passed (${absoluteFiles.length} production files, ${edges.length} local edges, no cycles).`)
}
