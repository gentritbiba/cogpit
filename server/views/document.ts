/**
 * The finished page of a stored view. It needs no network and no other file:
 * the kit and the app's modules travel inside it as JSON, and a small loader
 * evaluates them in order. The same page runs in a desktop frame and an iOS
 * web view; the viewer only swaps in its theme (`withViewTheme`).
 */
import { scriptJson, VIEW_BASE_CSS, viewKitScript } from "../../shared/views/frame"
import type { ViewKitModule } from "./kit"

export type ViewDocumentModule =
  | { name: string; kind: "js"; code: string; map: Record<string, string> }
  | { name: string; kind: "json"; value: unknown }
  | { name: string; kind: "css"; css: string }

export interface ViewDocumentInput {
  title: string
  kit: ViewKitModule[]
  modules: ViewDocumentModule[]
  entry: string
}

/**
 * Runs the payload: kit modules first, each registering the specifiers it
 * provides, then the app from its entry. Indirect eval with a sourceURL keeps
 * the agent's file names and line numbers (sucrase preserves lines) in errors.
 */
const LOADER = String.raw`(() => {
  const payload = JSON.parse(document.getElementById("cogpit-view-modules").textContent)
  const records = Object.create(null)
  const cache = Object.create(null)
  const evaluate = (code, url) => (0, eval)("(function (require, module, exports) {" + code + "\n})\n//# sourceURL=" + url)
  const load = (name) => {
    if (cache[name]) return cache[name].exports
    const record = records[name]
    if (!record) throw new Error("Cannot find module \"" + name + "\"")
    const module = { exports: {} }
    cache[name] = module
    if (record.kind === "json") module.exports = record.value
    else if (record.kind === "css") document.head.append(Object.assign(document.createElement("style"), { textContent: record.css }))
    else evaluate(record.code, record.name)((specifier) => load(record.map[specifier] ?? specifier), module, module.exports)
    return module.exports
  }
  for (const kit of payload.kit) {
    const module = { exports: {} }
    evaluate(kit.code, "cogpit-kit/" + kit.id + ".js")(load, module, module.exports)
    for (const [name, exports] of Object.entries(module.exports.modules)) cache[name] = { exports }
  }
  for (const record of payload.modules) records[record.name] = record
  load("cogpit/runtime").mount(() => load(payload.entry))
})()`

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`)

export function composeStoredViewDocument({ title, kit, modules, entry }: ViewDocumentInput): string {
  const payload = { kit: kit.map(({ id, code }) => ({ id, code })), modules, entry }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escapeHtml(title)}</title><style>${VIEW_BASE_CSS}\n${kit.map((module) => module.css).join("\n")}</style>`
    + viewKitScript(null)
    + `<script type="application/json" id="cogpit-view-modules">${scriptJson(payload)}</script>`
    + `</head><body><div id="root"></div><script>${LOADER}</script></body></html>`
}
