import { createContext } from "react"

/**
 * Fenced code blocks an agent writes to show structure instead of prose:
 * ```cogpit-status, ```cogpit-decisions and ```cogpit-checklist, and
 * ```cogpit-view for an interactive page it builds. Kept apart from their
 * renderers so the markdown renderer can recognize one without loading it.
 */

export type CogpitBlockKind = "status" | "decisions" | "checklist"

const KINDS: Readonly<Record<string, CogpitBlockKind>> = {
  "cogpit-status": "status",
  "cogpit-decisions": "decisions",
  "cogpit-checklist": "checklist",
}

export function cogpitBlockKind(lang: string | null): CogpitBlockKind | null {
  return (lang && KINDS[lang.toLowerCase()]) || null
}

export function isCogpitView(lang: string | null): boolean {
  return lang?.toLowerCase() === "cogpit-view"
}

const FENCE = /^[\s>]*(`{3,}|~{3,})/

/**
 * Whether the markdown of a fenced block, opening fence included, also holds
 * its closing fence. A reply still streaming in has not written it yet.
 */
export function isFenceClosed(markdown: string): boolean {
  const lines = markdown.trimEnd().split("\n")
  const open = lines[0]?.match(FENCE)?.[1]
  const close = lines.length > 1 ? lines[lines.length - 1].match(/^[\s>]*(`{3,}|~{3,})[ \t]*$/)?.[1] : undefined
  return Boolean(open && close && close[0] === open[0] && close.length >= open.length)
}

/**
 * The agent reply being drawn, which blocks render only inside: a prompt that
 * quotes one, or a plan or message that carries one, shows it as code.
 * `messageKey` names the reply, so a block's answers stay with that reply;
 * `markdown` is the text the renderer parsed, which block positions index.
 */
export const CogpitBlockScope = createContext<{ messageKey: string; markdown: string } | null>(null)
