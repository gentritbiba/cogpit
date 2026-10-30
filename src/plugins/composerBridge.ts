import type { ComposerDraft } from "../../shared/session/composerContext"
import type { CreatedComposerSession } from "@/lib/composerDraftIdentity"

/** Which composer a snapshot belongs to. `key` is the device- and account-scoped composer key. */
export interface ComposerScope { key: string; cwd: string | null; identity: string }

export interface ComposerSnapshot {
  /** Opaque; changes with every edit, scope switch and send. */
  token: string
  scope: ComposerScope
  draft: ComposerDraft
  /** An image upload or send is in flight; `replace` refuses until it settles. */
  busy: boolean
}

export type ComposerEvent =
  | { type: "change"; snapshot: ComposerSnapshot }
  /** Account, project or session identity changed under the composer. */
  | { type: "scope"; snapshot: ComposerSnapshot }
  | { type: "before-send"; sendId: string; scope: ComposerScope; draft: ComposerDraft }
  | { type: "settled"; sendId: string; sent: boolean }
  /** A first prompt created a session; the draft now belongs to that identity. */
  | { type: "created"; sendId: string; session: CreatedComposerSession }

export interface ComposerKeyInput {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  isComposing: boolean
  selectionStart: number
  selectionEnd: number
  /** Slash-command or file suggestions are open; they own the arrow keys. */
  suggestionsOpen: boolean
}

/** What a mounted composer offers extensions. Implemented by the composer, never by an extension. */
export interface ComposerHandle {
  snapshot(): ComposerSnapshot
  /** Replaces the draft only when `expectedToken` is current and the composer is not busy; null otherwise. */
  replace(draft: ComposerDraft, expectedToken: string): ComposerSnapshot | null
  focus(): void
}

/** A key handler an active extension installs; returning true consumes the key. */
export type ComposerKeyHandler = (input: ComposerKeyInput, composer: ComposerHandle) => boolean

let active: ComposerHandle | null = null
const listeners = new Set<(event: ComposerEvent) => void>()
const keyHandlers = new Set<ComposerKeyHandler>()

/** Called by the composer while mounted; the most recently registered composer is the active one. */
export function registerComposer(handle: ComposerHandle): () => void {
  active = handle
  return () => { if (active === handle) active = null }
}
export function activeComposer(): ComposerHandle | null { return active }

/**
 * Called by the composer for every lifecycle event. `settled` and `created`
 * finish a send that may outlive its composer, so they are always delivered;
 * the others only while the emitting composer is active.
 */
export function emitComposerEvent(handle: ComposerHandle, event: ComposerEvent): void {
  if (handle !== active && event.type !== "settled" && event.type !== "created") return
  for (const listener of [...listeners]) {
    try { listener(event) } catch { /* One extension cannot stop another or the composer. */ }
  }
}
export function onComposerEvent(listener: (event: ComposerEvent) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Called by the composer's key handler before its own handling; true means an extension consumed the key. */
export function dispatchComposerKey(handle: ComposerHandle, input: ComposerKeyInput): boolean {
  if (handle !== active) return false
  for (const handler of [...keyHandlers]) {
    try { if (handler(input, handle)) return true } catch { /* A failing extension leaves the key to the composer. */ }
  }
  return false
}
export function addComposerKeyHandler(handler: ComposerKeyHandler): () => void {
  keyHandlers.add(handler)
  return () => { keyHandlers.delete(handler) }
}
