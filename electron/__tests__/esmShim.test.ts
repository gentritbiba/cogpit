// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { resolveConfig } from "electron-vite"
import { parseAst } from "rollup/parseAst"
import { rollup, type Plugin, type PluginContext, type RenderChunkHook, type RenderedChunk, type NormalizedOutputOptions } from "rollup"

let temporary: string
let shim: Plugin
let render: (this: PluginContext, ...args: Parameters<RenderChunkHook>) => ReturnType<RenderChunkHook> | Promise<ReturnType<RenderChunkHook>>
beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "cogpit-esm-shim-"))
  const config = join(temporary, "electron.vite.config.mjs")
  await writeFile(config, "export default { main: {} }\n")
  const previousEnvironment = process.env.NODE_ENV
  try {
    const resolved = await resolveConfig({ root: temporary, configFile: config, envFile: false, logLevel: "silent" }, "build", "production")
    shim = (resolved.config!.main!.plugins! as Plugin[]).find(plugin => plugin.name === "vite:esm-shim")!
    if (!shim?.renderChunk) throw new Error("Electron ESM shim hook was not installed")
    render = typeof shim.renderChunk === "function" ? shim.renderChunk : shim.renderChunk.handler
  } finally {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousEnvironment
  }
})
afterAll(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }) })

async function transform(code: string, format: "es" | "cjs" = "es") {
  const result = await render.call({ parse: parseAst } as PluginContext, code, {} as RenderedChunk, { format, sourcemap: true } as NormalizedOutputOptions, { chunks: {} })
  if (!result || typeof result === "string") throw new Error("Expected shim transform result")
  return result
}

describe("patched electron-vite ESM shim", () => {
  it.each([
    'export const message = "legacy import";\nexport const provider = "clickup";',
    'export const message = `fake import "unrelated"`;',
    '/* fake import "unrelated"; */\nexport const message = "kept";',
    'export const expression = /import "unrelated"/;',
  ])("ignores import-like text in JavaScript syntax: %s", async source => {
    const code = `import path from 'node:path';\n${source}\nexport const directory = __dirname;\nexport { path };`
    const output = await transform(code)
    const parsed = parseAst(output.code)
    const imports = parsed.body.filter(node => node.type === "ImportDeclaration")
    expect(imports[0]).toMatchObject({ source: { value: "node:path" } })
    expect(imports.some(node => node.source.value === "node:module")).toBe(true)
    expect(output.code).toContain(source)
    expect(output.code.indexOf("// -- CommonJS Shims --")).toBeLessThan(output.code.indexOf(source))
    expect(output.map).toBeTruthy()
  })
  it("places shims after the last real import, including import attributes", async () => {
    const code = "import 'node:path';\nimport data from './data.json' with { type: 'json' };\nexport const directory = __dirname;\nexport { data };"
    const output = await transform(code)
    expect(() => parseAst(output.code)).not.toThrow()
    expect(output.code.indexOf("// -- CommonJS Shims --")).toBeGreaterThan(output.code.indexOf("with { type: 'json' }"))
  })
  it("inserts at the beginning when there is no real import and does not double-shim", async () => {
    const code = 'export const message = "legacy import";\nexport const provider = "clickup";\nexport const directory = __dirname;'
    const output = await transform(code)
    expect(() => parseAst(output.code)).not.toThrow()
    expect(output.code.trimStart().startsWith("// -- CommonJS Shims --")).toBe(true)
    const repeated = await render.call({ parse: parseAst } as PluginContext, output.code, {} as RenderedChunk, { format: "es" } as NormalizedOutputOptions, { chunks: {} })
    expect(repeated).toBeNull()
  })
  it("keeps CommonJS output and ESM without CJS references unchanged", async () => {
    for (const [code, format] of [["module.exports = require('node:path')", "cjs"], ["export const value = 1", "es"]] as const) {
      expect(await render.call({ parse: parseAst } as PluginContext, code, {} as RenderedChunk, { format } as NormalizedOutputOptions, { chunks: {} })).toBeNull()
    }
  })
  it("works through the actual Rollup render context", async () => {
    const bundle = await rollup({ input: "fixture", external: id => id.startsWith("node:"), plugins: [
      { name: "fixture", resolveId(id) { if (id === "fixture") return id }, load(id) { if (id === "fixture") return 'import "node:path"; export const message = "legacy import"; export const provider = "clickup"; export const directory = __dirname;' } },
      shim,
    ] })
    try {
      const generated = await bundle.generate({ format: "es", sourcemap: true })
      const chunk = generated.output.find(file => file.type === "chunk")!
      expect(() => parseAst(chunk.code)).not.toThrow()
      expect(chunk.code).toContain('"legacy import"')
      expect(chunk.code).toContain("// -- CommonJS Shims --")
    } finally { await bundle.close() }
  })
})
