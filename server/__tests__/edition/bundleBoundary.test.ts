// @vitest-environment node
import { join } from "node:path"
import type { Rollup } from "vite"
import { describe, expect, it } from "vitest"
import { bundleViolations } from "../../../build/bundleBoundary"
import { chunkFileNames, EDITION_UI_BANNER, editionUiBanner, isEditionUiChunk } from "../../../build/manualChunks"
import { root, TEAM_EDITION_UI_ENTRY } from "../../../scripts/lib/sourceFiles"

const UI_ENTRY = join(root, TEAM_EDITION_UI_ENTRY)

interface ChunkShape {
  modules: string[]
  isEntry?: boolean
  imports?: string[]
  facade?: string
}

/** A bundle of chunks by file name, holding the repo-relative modules named. */
function bundle(chunks: Record<string, ChunkShape>, assets: Record<string, string> = {}): Rollup.OutputBundle {
  const outputs = Object.entries(chunks).map(([fileName, chunk]) => ({
    type: "chunk",
    fileName,
    isEntry: chunk.isEntry ?? false,
    imports: chunk.imports ?? [],
    facadeModuleId: chunk.facade ?? null,
    moduleIds: chunk.modules.map((module) => join(root, module)),
  }))
  const maps = Object.entries(assets).map(([fileName, source]) => ({ type: "asset", fileName, source }))
  return Object.fromEntries([...outputs, ...maps].map((output) => [output.fileName, output])) as unknown as Rollup.OutputBundle
}

/** A team build as it should be: the UI in its own chunk, which only a dynamic import reaches. */
const TEAM_BUILD = {
  "assets/index.js": { modules: ["src/main.tsx", "src/edition/load.ts"], isEntry: true, imports: ["assets/vendor-react.js"] },
  "assets/vendor-react.js": { modules: ["node_modules/react/index.js"] },
  "assets/edition-ui.js": { modules: [TEAM_EDITION_UI_ENTRY, "editions/team/ui/panel/index.tsx"], facade: UI_ENTRY },
}

describe("isEditionUiChunk", () => {
  it("recognises the edition UI entry whichever path separator the id uses", () => {
    expect(isEditionUiChunk({ facadeModuleId: `C:\\repo\\${TEAM_EDITION_UI_ENTRY.replaceAll("/", "\\")}` })).toBe(true)
    expect(isEditionUiChunk({ facadeModuleId: `/repo/${TEAM_EDITION_UI_ENTRY}` })).toBe(true)
    expect(isEditionUiChunk({ facadeModuleId: "/repo/src/main.tsx" })).toBe(false)
  })
})

describe("bundleViolations", () => {
  it("passes a team build with its UI in one lazy chunk", () => {
    expect(bundleViolations(bundle(TEAM_BUILD), "present")).toEqual([])
  })

  it("passes a public build without one", () => {
    const { "assets/edition-ui.js": _ui, ...publicBuild } = TEAM_BUILD
    expect(bundleViolations(bundle(publicBuild), "absent")).toEqual([])
  })

  it.each(["server/http.ts", "electron/main.ts", "editions/team/server/store.ts", "editions/team/index.ts"])(
    "fails a chunk that holds server code: %s",
    (module) => {
      const violations = bundleViolations(bundle({ ...TEAM_BUILD, "assets/leak.js": { modules: [module] } }), null)
      expect(violations).toEqual([`assets/leak.js holds server code: ${module}`])
    },
  )

  it("fails edition UI outside its chunk", () => {
    const violations = bundleViolations(bundle({
      ...TEAM_BUILD,
      "assets/PanelView.js": { modules: ["editions/team/ui/panel/PanelView.tsx"] },
    }), null)
    expect(violations).toEqual([
      "assets/PanelView.js holds edition UI outside the edition-ui chunk: editions/team/ui/panel/PanelView.tsx",
    ])
  })

  it("fails an entry that loads the edition UI eagerly, however indirectly", () => {
    const violations = bundleViolations(bundle({
      ...TEAM_BUILD,
      "assets/vendor-react.js": { modules: ["node_modules/react/index.js"], imports: ["assets/edition-ui.js"] },
    }), null)
    expect(violations).toEqual([
      "assets/index.js loads assets/edition-ui.js eagerly; the edition UI may only be imported dynamically",
    ])
  })

  it("fails a build whose edition UI chunk is not what it expects", () => {
    const { "assets/edition-ui.js": _ui, ...publicBuild } = TEAM_BUILD
    expect(bundleViolations(bundle(publicBuild), "present")).toEqual(["no edition-ui chunk, but COGPIT_EXPECT_EDITION_UI=present"])
    expect(bundleViolations(bundle(TEAM_BUILD), "absent")).toEqual(["assets/edition-ui.js emitted, but COGPIT_EXPECT_EDITION_UI=absent"])
  })

  it("fails a source map that names the edition's sources", () => {
    const violations = bundleViolations(bundle(TEAM_BUILD, {
      "assets/edition-ui.js.map": JSON.stringify({ sources: ["../../editions/team/ui/index.ts"] }),
      "assets/index.js.map": JSON.stringify({ sources: ["../../src/main.tsx"] }),
    }), null)
    expect(violations).toEqual(["assets/edition-ui.js.map maps the edition package's sources"])
  })
})

describe("the edition UI chunk's name and banner", () => {
  const chunk = (facadeModuleId: string | null) => ({ facadeModuleId }) as Rollup.PreRenderedChunk
  const MINIFIED = 'import{a}from"./index.js";export default{edition:"team",ui:a}'

  /** The code of each chunk once the banner plugin has seen the finished bundle. */
  function bannered(facades: Record<string, string | null>): Record<string, string> {
    const output = Object.fromEntries(Object.entries(facades).map(([fileName, facadeModuleId]) => (
      [fileName, { type: "chunk", fileName, facadeModuleId, code: MINIFIED }]
    ))) as unknown as Rollup.OutputBundle
    const { generateBundle } = editionUiBanner()
    if (typeof generateBundle !== "function") throw new Error("the banner plugin has no generateBundle hook")
    generateBundle.call({} as never, {} as never, output, false)
    return Object.fromEntries(Object.values(output).map((chunk) => [chunk.fileName, (chunk as Rollup.OutputChunk).code]))
  }

  it("names the edition UI chunk and marks it proprietary on its first line", () => {
    expect(chunkFileNames(chunk(UI_ENTRY))).toBe("assets/edition-ui-[hash].js")
    expect(EDITION_UI_BANNER).toBe("/*! Cogpit Team UI - proprietary, not covered by the MIT license */")
    expect(bannered({ "assets/edition-ui.js": UI_ENTRY })["assets/edition-ui.js"]).toBe(`${EDITION_UI_BANNER}\n${MINIFIED}`)
  })

  it("leaves every other chunk as Vite names it, without a banner", () => {
    const facades = [join(root, "src/main.tsx"), join(root, "src/edition/absent.ts"), null]
    for (const facade of facades) expect(chunkFileNames(chunk(facade))).toBe("assets/[name]-[hash].js")
    const code = bannered(Object.fromEntries(facades.map((facade, index) => [`assets/chunk-${index}.js`, facade])))
    expect(Object.values(code)).toEqual(facades.map(() => MINIFIED))
  })
})
