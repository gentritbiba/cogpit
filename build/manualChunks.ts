/**
 * Shared manual chunk splitting for Vite/Rollup builds.
 *
 * Used by both vite.config.ts (dev/web) and electron.vite.config.ts
 * (Electron renderer) to keep vendor bundles consistent.
 */

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
  "node_modules/@tanstack/react-virtual/",
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
