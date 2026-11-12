/**
 * Shared chunk splitting and naming for Vite/Rollup builds.
 *
 * Used by both vite.config.ts (dev/web) and electron.vite.config.ts
 * (Electron renderer) to keep vendor bundles consistent.
 */
import type { Plugin, Rollup } from "vite"
import { TEAM_EDITION_UI_ENTRY } from "../scripts/lib/sourceFiles"

/** The name of the one lazy chunk that holds an edition package's UI; builds without one emit none. */
export const EDITION_UI_CHUNK = "edition-ui"

/** The edition UI is not MIT-licensed, and its chunk says so on its first line wherever it ships. */
export const EDITION_UI_BANNER = "/*! Cogpit Team UI - proprietary, not covered by the MIT license */"

const REACT_PATTERNS = [
  "node_modules/react/",
  "node_modules/react-dom/",
  "node_modules/scheduler/",
  "commonjsHelpers.js",
]

const SHIKI_PATTERNS = [
  "node_modules/shiki/",
  "node_modules/@shikijs/core/",
  "node_modules/@shikijs/engine-javascript/",
  "node_modules/@shikijs/vscode-textmate/",
  "node_modules/@shikijs/types/",
]

const MARKDOWN_PATTERNS = [
  "node_modules/react-markdown/",
  "node_modules/remark-",
  "node_modules/rehype-",
  "node_modules/unified/",
  "node_modules/mdast-",
  "node_modules/hast-",
  "node_modules/micromark",
]

const UI_PATTERNS = [
  "node_modules/@base-ui/",
  "node_modules/@floating-ui/",
  "node_modules/@radix-ui/",
  "node_modules/lucide-react/",
  "node_modules/react-resizable-panels/",
  "node_modules/class-variance-authority/",
  "node_modules/clsx/",
  "node_modules/tailwind-merge/",
]

function matchesAny(id: string, patterns: string[]): boolean {
  return patterns.some((p) => id.includes(p))
}

export function manualChunks(id: string): string | undefined {
  if (matchesAny(id, REACT_PATTERNS)) return "vendor-react"
  if (matchesAny(id, SHIKI_PATTERNS)) return "vendor-shiki"
  if (matchesAny(id, MARKDOWN_PATTERNS)) return "vendor-markdown"
  if (matchesAny(id, UI_PATTERNS)) return "vendor-ui"
  return undefined
}

/**
 * The chunk that `@cogpit/edition-ui`'s dynamic import starts. It is left to
 * Rollup's own splitting rather than made a manual chunk, which would pull
 * every core module the UI imports into it and so into every entry's imports.
 */
export function isEditionUiChunk(chunk: Pick<Rollup.PreRenderedChunk, "facadeModuleId">): boolean {
  return chunk.facadeModuleId?.replaceAll("\\", "/").endsWith(`/${TEAM_EDITION_UI_ENTRY}`) ?? false
}

/** Vite's own chunk names, with the edition UI's under a name its checks and banner can find. */
export function chunkFileNames(chunk: Rollup.PreRenderedChunk): string {
  return isEditionUiChunk(chunk) ? `assets/${EDITION_UI_CHUNK}-[hash].js` : "assets/[name]-[hash].js"
}

/**
 * Puts the banner on the edition UI chunk once its code is final. Rollup's own
 * `output.banner` would not stay first: minification hoists the chunk's
 * imports above it.
 */
export function editionUiBanner(): Plugin {
  return {
    name: "cogpit:edition-ui-banner",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk" && isEditionUiChunk(output)) output.code = `${EDITION_UI_BANNER}\n${output.code}`
      }
    },
  }
}
