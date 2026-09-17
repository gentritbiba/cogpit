import { readFile } from "node:fs/promises"
import { dirname, extname, join, resolve } from "node:path"
import ts from "typescript"
import { collectSourceRoots, relativePath, root } from "./lib/sourceFiles"

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
const sourceRoots = ["shared", "src", "plugins", "server", "electron", "packages/cogpit-memory/src", ...Object.values(publicPackages).map((path) => `${path}/src`)]
const emittedExtensions = new Set([".js", ".jsx", ".mjs", ".cjs"])

interface ImportReference {
  specifier: string
  line: number
}

interface Edge {
  source: string
  target: string
  line: number
}

function extractImports(source: string, fileName: string): ImportReference[] {
  const references: ImportReference[] = []
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  const addReference = (specifier: ts.Expression, position: number) => {
    if (ts.isStringLiteralLike(specifier)) {
      references.push({
        specifier: specifier.text,
        line: sourceFile.getLineAndCharacterOfPosition(position).line + 1,
      })
    }
  }

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) addReference(node.moduleSpecifier, node.getStart(sourceFile))
    } else if (
      ts.isCallExpression(node)
      && node.arguments.length === 1
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      addReference(node.arguments[0], node.getStart(sourceFile))
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return references
}

function resolveLocalImport(source: string, specifier: string, files: Set<string>): string | null {
  let unresolved: string
  if (publicExports.has(specifier)) {
    unresolved = publicExports.get(specifier)!
  } else if (specifier.startsWith("@/")) {
    unresolved = join(root, "src", specifier.slice(2))
  } else if (specifier.startsWith(".")) {
    unresolved = resolve(dirname(source), specifier)
  } else {
    return null
  }

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

function layer(path: string): "shared" | "src" | "plugin" | "server" | "electron" | "package" | null {
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
    const target = resolveLocalImport(source, reference.specifier, fileSet)
    if (!target) continue
    edges.push({ source: relativePath(source), target: relativePath(target), line: reference.line })
  }
}

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
