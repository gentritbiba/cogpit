import { renderWork } from "./rendering/service"
export type { ThemedToken } from "shiki/core"

// ── Extension → Shiki language mapping ──────────────────────────────────────

export const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript",
  py: "python", rs: "rust", go: "go", json: "json",
  css: "css", scss: "scss", html: "html", htm: "html",
  md: "markdown", mdx: "markdown", yml: "yaml", yaml: "yaml",
  toml: "toml", sh: "bash", bash: "bash", zsh: "bash",
  sql: "sql", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
  java: "java", rb: "ruby", swift: "swift", kt: "kotlin", kts: "kotlin",
  php: "php", vue: "vue", svelte: "svelte",
}

export function getLangFromPath(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
  return EXT_TO_LANG[ext] ?? null
}

export function highlightCode(code: string, lang: string, isDark: boolean, signal?: AbortSignal) {
  return renderWork.highlight(code, lang, isDark, signal)
}
