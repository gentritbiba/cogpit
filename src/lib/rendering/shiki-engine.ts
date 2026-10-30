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

function getHighlighter(): Promise<HighlighterCore> {
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

async function ensureLang(
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

export async function tokenize(code: string, lang: string, isDark: boolean): Promise<ThemedToken[][] | null> {
  const hl = await getHighlighter()
  await ensureLang(hl, lang)
  if (!hl.getLoadedLanguages().includes(lang)) return null
  return hl.codeToTokens(code, { lang, theme: isDark ? "github-dark" : "github-light" }).tokens
}
