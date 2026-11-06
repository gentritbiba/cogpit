/**
 * Builds a stored view's source into its finished page on the computer that
 * owns it. Each file is compiled on its own with sucrase (pure JavaScript, so
 * it runs the same under Electron and Bun); imports are resolved here, so a
 * missing file or an unknown package fails the build with its location
 * instead of failing in front of the user.
 */
import { posix } from "node:path"
import { createRequire } from "node:module"
import { transform } from "sucrase"
import type * as SucraseParser from "sucrase/dist/types/parser"
import type { ViewSourceFile } from "../../shared/views/stored"
import { composeStoredViewDocument, type ViewDocumentModule } from "./document"
import { kitModuleFor, kitSpecifiers, VIEW_KIT, type ViewKitIndex, type ViewKitModule } from "./kit"

/** sucrase's own parser, which it types in declarations shipped apart from the module. */
const { parse } = createRequire(import.meta.url)("sucrase/dist/parser") as typeof SucraseParser

export interface ViewBuildError {
  file?: string
  line?: number
  column?: number
  message: string
}

export type ViewBuildResult = { ok: true; html: string } | { ok: false; errors: ViewBuildError[] }

export const VIEW_ENTRIES = ["App.tsx", "App.jsx", "App.ts", "App.js"] as const
const SCRIPT = /\.(?:tsx|ts|jsx|js)$/
const RESOLVE_SUFFIXES = ["", ".tsx", ".ts", ".jsx", ".js", ".json", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"]

export function formatBuildError({ file, line, column, message }: ViewBuildError): string {
  if (!file) return message
  let where = file
  if (line) where += column ? `:${line}:${column}` : `:${line}`
  return `${where}: ${message}`
}

function compile(file: ViewSourceFile): { code: string } | { error: ViewBuildError } {
  const typed = /\.tsx?$/.test(file.path)
  const jsx = !file.path.endsWith(".ts")
  try {
    const { code } = transform(file.text, {
      transforms: [...(typed ? ["typescript" as const] : []), ...(jsx ? ["jsx" as const] : []), "imports"],
      jsxRuntime: "automatic",
      production: true,
      filePath: file.path,
    })
    return { code }
  } catch (error) {
    const loc = (error as { loc?: { line: number; column: number } }).loc
    const message = (error instanceof Error ? error.message : String(error))
      .replace(/^Error transforming [^:]+: /, "")
      .replace(/ \(\d+:\d+\)$/, "")
    return { error: { file: file.path, line: loc?.line, column: loc ? loc.column + 1 : undefined, message } }
  }
}

/** The source text of each token: comments are not tokens, and a string is one token, quotes included. */
function tokenTexts(code: string, jsx: boolean, typed: boolean): string[] {
  return parse(code, jsx, typed, false).tokens.map((token) => code.slice(token.start, token.end))
}

/** The modules compiled code requires: `require("x")` calls, never text in a string or comment that looks like one. */
function requiredSpecifiers(code: string): Set<string> {
  const texts = tokenTexts(code, false, false)
  const found = new Set<string>()
  texts.forEach((text, index) => {
    const literal = texts[index + 2]
    if (text === "require" && texts[index + 1] === "(" && texts[index + 3] === ")" && literal && /^['"]/.test(literal)) found.add(literal.slice(1, -1))
  })
  return found
}

/** Whether a source file exports a default: `export default …`, or `default` in an `export { … }` list. */
function exportsDefault(file: ViewSourceFile): boolean {
  const texts = tokenTexts(file.text, !file.path.endsWith(".ts"), /\.tsx?$/.test(file.path))
  return texts.some((text, index) => {
    if (text !== "export") return false
    if (texts[index + 1] === "default") return true
    if (texts[index + 1] !== "{") return false
    const close = texts.indexOf("}", index)
    return texts.slice(index + 2, close === -1 ? undefined : close).includes("default")
  })
}

function resolveRelative(from: string, specifier: string, files: ReadonlyMap<string, ViewSourceFile>): string | null {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier))
  if (base.startsWith("../") || base === "..") return null
  for (const suffix of RESOLVE_SUFFIXES) {
    if (files.has(base + suffix)) return base + suffix
  }
  return null
}

/** Compiles what the entry reaches and composes the page; every problem found is reported, not just the first. */
export function buildView({ title, files }: { title: string; files: readonly ViewSourceFile[] }, kit: ViewKitIndex = VIEW_KIT): ViewBuildResult {
  const byPath = new Map(files.map((file) => [file.path, file]))
  const entry = VIEW_ENTRIES.find((name) => byPath.has(name))
  if (!entry) return { ok: false, errors: [{ message: "A view needs App.tsx with a default export: the component to show" }] }

  const errors: ViewBuildError[] = []
  const modules: ViewDocumentModule[] = []
  const usedKit = new Set<ViewKitModule>(kit.modules.filter((module) => module.always))
  const queue: string[] = [entry]
  const seen = new Set(queue)

  while (queue.length > 0) {
    const file = byPath.get(queue.shift()!)!
    if (file.path.endsWith(".json")) {
      try {
        modules.push({ name: file.path, kind: "json", value: JSON.parse(file.text) })
      } catch (error) {
        errors.push({ file: file.path, message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` })
      }
      continue
    }
    if (file.path.endsWith(".css")) {
      modules.push({ name: file.path, kind: "css", css: file.text })
      continue
    }
    if (!SCRIPT.test(file.path)) {
      errors.push({ file: file.path, message: "Only .tsx, .ts, .jsx, .js, .css and .json files can be imported" })
      continue
    }
    const compiled = compile(file)
    if ("error" in compiled) {
      errors.push(compiled.error)
      continue
    }
    if (file.path === entry && !exportsDefault(file)) {
      errors.push({ file: file.path, message: "Needs a default export: the component to show" })
    }
    const map: Record<string, string> = {}
    for (const specifier of requiredSpecifiers(compiled.code)) {
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const target = resolveRelative(file.path, specifier, byPath)
        if (!target) {
          errors.push({ file: file.path, message: `Cannot find "${specifier}" in the view's files` })
          continue
        }
        map[specifier] = target
        if (!seen.has(target)) {
          seen.add(target)
          queue.push(target)
        }
        continue
      }
      const provider = kitModuleFor(specifier, kit)
      if (provider && specifier !== "cogpit/runtime") {
        usedKit.add(provider)
        continue
      }
      errors.push({
        file: file.path,
        message: `Cannot import "${specifier}": a view has no network or npm. Use ${kitSpecifiers(kit).join(", ")}, or write it in the view's own files`,
      })
    }
    modules.push({ name: file.path, kind: "js", code: compiled.code, map })
  }

  if (errors.length > 0) return { ok: false, errors }
  const html = composeStoredViewDocument({ title, kit: kit.modules.filter((module) => usedKit.has(module)), modules, entry })
  return { ok: true, html }
}
