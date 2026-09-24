// ── The installed edition UI ────────────────────────────────────────────
//
// One module cell per page. The UI is installed at most once and never
// removed: a later device of another edition leaves it in place, and its
// components decide for themselves whether the active device is theirs.

import type { EditionUi, EditionUiModule } from "./contract"
import { PERSONAL_UI } from "./personal"

/**
 * Idle until an edition other than personal asks for its UI; unavailable when
 * this build has none for it, or could not load it for a remote device; failed
 * when the connected server's own UI could not be fetched.
 */
export type EditionUiState = "idle" | "loading" | "installed" | "unavailable" | "failed"

let ui: EditionUi = PERSONAL_UI
let state: EditionUiState = "idle"
const listeners = new Set<() => void>()

function publish(nextUi: EditionUi, nextState: EditionUiState): void {
  ui = nextUi
  state = nextState
  for (const listener of listeners) listener()
}

/** The installed edition's slots, or personal edition's empty set. */
export function editionUi(): EditionUi {
  return ui
}

export function editionUiState(): EditionUiState {
  return state
}

export function subscribeEditionUi(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Install an edition's UI, once per page. */
export function installEditionUi(module: EditionUiModule): void {
  if (state === "installed") throw new Error(`An edition UI is already installed; ${module.edition} cannot replace it`)
  publish(module.ui, "installed")
}

/** A load has started. An installed UI stays installed. */
export function markEditionUiLoading(): void {
  if (state !== "installed") publish(ui, "loading")
}

/** This build has no UI for the edition asked for, or could not load it. */
export function markEditionUiUnavailable(): void {
  if (state !== "installed") publish(ui, "unavailable")
}

/** The connected server's own edition UI could not be fetched. */
export function markEditionUiFailed(): void {
  if (state !== "installed") publish(ui, "failed")
}

export function __installEditionUiForTest(testUi: EditionUi): void {
  publish(testUi, "installed")
}

export function __resetEditionUiForTest(): void {
  publish(PERSONAL_UI, "idle")
}
