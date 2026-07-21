/**
 * Shared Shiki highlighter singleton.
 *
 * Uses shiki/core with the JavaScript regex engine (no WASM) and
 * only the 2 themes + 11 default languages needed by the app.
 * All themes and languages are dynamically imported to keep the
 * initial bundle small.
 */
import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageInput,
  type ThemedToken,
} from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"

export type { ThemedToken } from "shiki/core"

let highlighterPromise: Promise<HighlighterCore> | null = null
const loadedLangs = new Set<string>()
const loadingLangs = new Map<string, Promise<void>>()

const DEFAULT_LANG_IDS = [
  "typescript", "tsx", "javascript", "jsx", "json",
  "css", "html", "python", "bash", "yaml", "markdown",
] as const

/** On-demand language loaders — only fetched when actually needed. */
const LANG_IMPORT_MAP: Record<string, () => Promise<{ default: unknown }>> = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  css: () => import("@shikijs/langs/css"),
  html: () => import("@shikijs/langs/html"),
  python: () => import("@shikijs/langs/python"),
  bash: () => import("@shikijs/langs/bash"),
  yaml: () => import("@shikijs/langs/yaml"),
  markdown: () => import("@shikijs/langs/markdown"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  toml: () => import("@shikijs/langs/toml"),
  sql: () => import("@shikijs/langs/sql"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  java: () => import("@shikijs/langs/java"),
  ruby: () => import("@shikijs/langs/ruby"),
  swift: () => import("@shikijs/langs/swift"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  php: () => import("@shikijs/langs/php"),
  vue: () => import("@shikijs/langs/vue"),
  svelte: () => import("@shikijs/langs/svelte"),
  scss: () => import("@shikijs/langs/scss"),
}

export function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      // Load themes + default languages in parallel
      const [themeDark, themeLight, ...defaultLangs] = await Promise.all([
        import("@shikijs/themes/github-dark").then(m => m.default),
        import("@shikijs/themes/github-light").then(m => m.default),
        ...DEFAULT_LANG_IDS.map(id => LANG_IMPORT_MAP[id]().then(m => m.default)),
      ])
      const hl = await createHighlighterCore({
        themes: [themeDark, themeLight],
        langs: defaultLangs as LanguageInput[],
        engine: createJavaScriptRegexEngine(),
      })
      for (const id of DEFAULT_LANG_IDS) loadedLangs.add(id)
      return hl
    })()
  }
  return highlighterPromise
}

export async function ensureLang(
  hl: HighlighterCore,
  lang: string,
): Promise<void> {
  if (loadedLangs.has(lang)) return
  if (loadingLangs.has(lang)) return loadingLangs.get(lang)!
  const importFn = LANG_IMPORT_MAP[lang]
  if (!importFn) return
  const promise = importFn()
    .then(async (mod) => {
      await hl.loadLanguage(mod.default as Parameters<HighlighterCore["loadLanguage"]>[0])
      loadedLangs.add(lang)
    })
    .finally(() => loadingLangs.delete(lang))
  loadingLangs.set(lang, promise)
  await promise
}

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

// ── Highlight a code string ─────────────────────────────────────────────────

export async function highlightCode(
  code: string,
  lang: string,
  isDark: boolean,
): Promise<ThemedToken[][] | null> {
  try {
    const hl = await getHighlighter()
    await ensureLang(hl, lang)
    const theme = isDark ? "github-dark" : "github-light"
    const result = hl.codeToTokens(code, { lang, theme })
    return result.tokens
  } catch {
    return null
  }
}
