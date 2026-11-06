/**
 * Builds the kit stored views run on into generated/view-kit/index.json, which
 * the server inlines into every page it builds. React's API is Preact
 * underneath, so the base stays a few kilobytes.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { build, transform } from "esbuild"
import { VIEW_KIT_MODULES } from "../src/viewKit/modules"
import type { ViewKitIndex } from "../server/views/kit"

const root = resolve(import.meta.dirname, "..")
const output = join(root, "generated/view-kit/index.json")

/** The base module aliases React to Preact; every other module leaves React's specifiers to it. */
async function bundle(entry: string, external: string[]): Promise<string> {
  const result = await build({
    entryPoints: [join(root, entry)],
    absWorkingDir: root,
    bundle: true,
    write: false,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    jsx: "automatic",
    ...(external.length === 0 ? { alias: { react: "preact/compat", "react-dom": "preact/compat" } } : {}),
    define: { "process.env.NODE_ENV": "\"production\"" },
    external,
    logLevel: "warning",
  })
  return result.outputFiles[0]!.text
}

const index: ViewKitIndex = { modules: [] }
for (const spec of VIEW_KIT_MODULES) {
  // Every view has the modules marked `always`, so others share them; anything else a module uses, it bundles.
  const external = spec.always ? [] : VIEW_KIT_MODULES.filter((other) => other.always).flatMap((other) => other.provides)
  const css = spec.css ? (await transform(readFileSync(join(root, spec.css), "utf8"), { loader: "css", minify: true })).code : ""
  index.modules.push({ id: spec.id, provides: [...spec.provides], always: spec.always === true, code: await bundle(spec.entry, external), css })
}

const text = `${JSON.stringify(index)}\n`
let previous = ""
try { previous = readFileSync(output, "utf8") } catch { /* first build */ }
if (previous !== text) {
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, text)
}
console.log(`view kit: ${index.modules.map((module) => `${module.id} ${(module.code.length / 1024).toFixed(1)} KB`).join(", ")}`)
