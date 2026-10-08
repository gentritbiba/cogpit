import { createContext } from "react"

/**
 * Fenced code blocks an agent writes to show structure instead of prose:
 * ```cogpit-status, ```cogpit-decisions and ```cogpit-checklist. Kept apart
 * from their parser so the markdown renderer can recognize one without
 * loading it.
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

/**
 * The agent reply being drawn, which blocks render only inside: a prompt that
 * quotes one, or a plan or message that carries one, shows it as code.
 * `messageKey` names the reply, so a block's answers stay with that reply.
 */
export const CogpitBlockScope = createContext<{ messageKey: string } | null>(null)
