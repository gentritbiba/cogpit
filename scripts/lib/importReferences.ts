import ts from "typescript"

export interface ImportReference {
  specifier: string
  line: number
}

/** Vitest calls whose first argument names a module to mock or to load around a mock. */
const MODULE_LOADING_VI_CALLS = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"])

function isNamed(node: ts.Expression, name: string): boolean {
  return ts.isIdentifier(node) && node.text === name
}

function isImportMeta(node: ts.Expression): boolean {
  return ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === "meta"
}

function isModuleLoadingCall(node: ts.CallExpression): boolean {
  const callee = node.expression
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true
  if (ts.isIdentifier(callee)) return callee.text === "require" && node.arguments.length === 1
  if (!ts.isPropertyAccessExpression(callee)) return false
  const method = callee.name.text
  if (isNamed(callee.expression, "vi")) return MODULE_LOADING_VI_CALLS.has(method)
  return method === "resolve" && (isNamed(callee.expression, "require") || isImportMeta(callee.expression))
}

/** A triple-slash `path` is relative to its file even when it does not start with a dot. */
function referencedPath(fileName: string): string {
  return fileName.startsWith(".") || fileName.startsWith("/") ? fileName : `./${fileName}`
}

/**
 * Every module a source file names: imports and re-exports, `import()`,
 * `require()`, `import x = require()`, `require.resolve()`,
 * `import.meta.resolve()`, a type's `import("…")`, triple-slash `path` and
 * `types` references, and the modules a Vitest test mocks. A type-only or
 * resolve-only reference counts: a checkout without the module fails just the
 * same.
 */
export function extractImports(source: string, fileName: string): ImportReference[] {
  const references: ImportReference[] = []
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  const lineAt = (position: number) => sourceFile.getLineAndCharacterOfPosition(position).line + 1
  const addReference = (node: ts.Node, specifier: ts.Node | undefined) => {
    if (specifier && ts.isStringLiteralLike(specifier)) {
      references.push({ specifier: specifier.text, line: lineAt(node.getStart(sourceFile)) })
    }
  }

  for (const reference of sourceFile.referencedFiles) {
    references.push({ specifier: referencedPath(reference.fileName), line: lineAt(reference.pos) })
  }
  for (const reference of sourceFile.typeReferenceDirectives) {
    references.push({ specifier: reference.fileName, line: lineAt(reference.pos) })
  }

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addReference(node, node.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addReference(node, node.moduleReference.expression)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addReference(node, node.argument.literal)
    } else if (ts.isCallExpression(node) && isModuleLoadingCall(node)) {
      addReference(node, node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return references
}
