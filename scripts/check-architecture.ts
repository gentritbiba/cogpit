import { readFile } from "node:fs/promises"
import { dirname, extname, join, resolve } from "node:path"
import ts from "typescript"
import { collectSourceRoots, relativePath, root } from "./lib/sourceFiles"

const sourceRoots = ["shared", "src", "plugins", "server", "electron", "packages/cogpit-memory/src"] as const
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
  if (specifier.startsWith("@/")) {
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
  const sourceLayer = layer(edge.source)
  const targetLayer = layer(edge.target)
  if (!sourceLayer || !targetLayer || sourceLayer === targetLayer) return false

  if (sourceLayer === "plugin") {
    return targetLayer !== "plugin"
      && targetLayer !== "shared"
      && !edge.target.startsWith("src/plugin-api/")
  }
  if (targetLayer === "plugin") {
    return edge.source !== "src/plugins/registry.ts"
  }
  if (targetLayer === "shared") return false
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

for (const source of absoluteFiles) {
  const contents = await readFile(source, "utf8")
  for (const reference of extractImports(contents, source)) {
    const target = resolveLocalImport(source, reference.specifier, fileSet)
    if (!target) continue
    edges.push({ source: relativePath(source), target: relativePath(target), line: reference.line })
  }
}

const violations: string[] = []
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
