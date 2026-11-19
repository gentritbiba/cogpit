/**
 * A stored view published to a public address. The page runs with no Cogpit
 * around it, so it carries both of the publisher's themes and follows the
 * visitor's light or dark setting.
 */
import { scriptJson, VIEW_THEME_TOKEN, type ViewTheme } from "./frame"

/** The light and dark colors Cogpit puts into a published page. */
export interface PublishThemes {
  light: ViewTheme["tokens"]
  dark: ViewTheme["tokens"]
}

/** Where a view is published, as the views list and its pages report it. */
export interface ViewPublication {
  /** The plugin that published it, which updates and takes it down. */
  pluginId: string
  /** That plugin's name for the host, such as "Share host". */
  title: string
  url: string
  /** The version the page shows. */
  version: number
  publishedAt: string
}

/** `POST /api/plugins/leases/<lease>/publish` body; answers `{ publication: ViewPublication }`. */
export interface PublishViewRequest {
  view: string
  version: number
  themes: PublishThemes
}

/** `POST /api/plugins/leases/<lease>/unpublish` body; answers `{ unpublished: true }`. */
export interface UnpublishViewRequest {
  view: string
}

const TOKEN_NAME = /^--[a-zA-Z0-9-]{1,64}$/
const MAX_TOKENS = 96
const MAX_VALUE_BYTES = 256

/** The tokens as given, or null when one is not a plain custom property or the set is too large. */
export function validThemeTokens(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.length > MAX_TOKENS) return null
  const tokens: Record<string, string> = {}
  for (const [name, token] of entries) {
    if (!TOKEN_NAME.test(name) || typeof token !== "string" || new TextEncoder().encode(token).byteLength > MAX_VALUE_BYTES || /[<>{};]/.test(token)) return null
    tokens[name] = token
  }
  return tokens
}

/**
 * The finished page with both themes in place of the viewer's: it starts in
 * the visitor's light or dark setting and switches when that changes, through
 * the same message a Cogpit window sends the frame.
 */
export function publishedViewDocument(html: string, themes: PublishThemes): string {
  const both = scriptJson({ light: { mode: "light", tokens: themes.light }, dark: { mode: "dark", tokens: themes.dark } })
  const follow = `((themes) => {
    const query = matchMedia("(prefers-color-scheme: dark)")
    const pick = () => query.matches ? themes.dark : themes.light
    query.addEventListener("change", () => postMessage({ type: "cogpit-view:theme", theme: pick() }, "*"))
    return pick()
  })(${both})`
  return html.replace(VIEW_THEME_TOKEN, () => follow)
}
