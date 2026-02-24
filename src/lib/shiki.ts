/**
 * Shared Shiki highlighter singleton.
 *
 * Provides a lazily-created highlighter with a default set of languages
 * pre-loaded, plus on-demand loading for any bundled Shiki language.
 */
import {
  createHighlighter,
  type BundledLanguage,
  type Highlighter,
  type ThemedToken,
} from "shiki"

let highlighterPromise: Promise<Highlighter> | null = null
const loadedLangs = new Set<string>()

const DEFAULT_LANGS = [
  "typescript", "tsx", "javascript", "jsx", "json",
  "css", "html", "python", "bash", "yaml", "markdown",
] as const

export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark", "github-light"],
      langs: [...DEFAULT_LANGS],
    }).then((hl) => {
      for (const l of DEFAULT_LANGS) loadedLangs.add(l)
      return hl
    })
  }
  return highlighterPromise
}

export async function ensureLang(
  hl: Highlighter,
  lang: BundledLanguage
): Promise<void> {
  if (loadedLangs.has(lang)) return
  await hl.loadLanguage(lang)
  loadedLangs.add(lang)
}

// ── Extension → Shiki language mapping ──────────────────────────────────────

export const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript",
  py: "python", rs: "rust", go: "go", json: "json",
  css: "css", scss: "css", html: "html", htm: "html",
  md: "markdown", mdx: "markdown", yml: "yaml", yaml: "yaml",
  toml: "toml", sh: "bash", bash: "bash", zsh: "bash",
  sql: "sql", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
  java: "java", rb: "ruby", swift: "swift", kt: "kotlin", kts: "kotlin",
  php: "php", vue: "vue", svelte: "svelte",
}

export function getLangFromPath(filePath: string): BundledLanguage | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
  return (EXT_TO_LANG[ext] as BundledLanguage) ?? null
}

// ── Highlight a code string ─────────────────────────────────────────────────

export async function highlightCode(
  code: string,
  lang: string,
  isDark: boolean
): Promise<ThemedToken[][] | null> {
  try {
    const hl = await getHighlighter()
    const bundledLang = lang as BundledLanguage
    await ensureLang(hl, bundledLang)
    const theme = isDark ? "github-dark" : "github-light"
    const result = hl.codeToTokens(code, { lang: bundledLang, theme })
    return result.tokens
  } catch {
    return null
  }
}
