// ── Loading the edition UI ──────────────────────────────────────────────
//
// The only core module that names `@cogpit/edition-ui`. The build resolves it
// to the edition package's UI entry, a lazy chunk of its own, or to an empty
// stub when the build has none. Personal edition never asks for it, so a
// personal session never downloads the chunk.

import { useCallback, useEffect, useSyncExternalStore } from "react"
import type { CogpitEdition } from "../../shared/contracts/identity"
import type { EditionUiModule } from "./contract"
import {
  editionUiState,
  installEditionUi,
  markEditionUiFailed,
  markEditionUiLoading,
  markEditionUiUnavailable,
  subscribeEditionUi,
} from "./registry"

/** Set while the page reloads for a chunk an upgraded server no longer serves, so it does so once. */
const STALE_CHUNK_RELOAD_KEY = "cogpit:edition-ui-reloaded"

let pending: Promise<EditionUiModule | null> | null = null

/** The edition UI module this build bundles, or null. A failed import is retried on the next call. */
export function importEditionUi(): Promise<EditionUiModule | null> {
  pending ??= import("@cogpit/edition-ui").then(
    (loaded) => loaded.default,
    (error: unknown) => {
      pending = null
      throw error
    },
  )
  return pending
}

/**
 * A tab open across a server upgrade asks for a chunk the new build no longer
 * has. Reloading picks up the new build; the flag, cleared by the next load
 * that succeeds or stops at the retry screen, keeps a chunk that fails for any
 * other reason from reloading the page in a loop.
 */
function reloadOnceForStaleChunk(): boolean {
  try {
    if (sessionStorage.getItem(STALE_CHUNK_RELOAD_KEY) !== null) return false
    sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, "1")
  } catch {
    return false
  }
  window.location.reload()
  return true
}

function forgetStaleChunkReload(): void {
  try {
    sessionStorage.removeItem(STALE_CHUNK_RELOAD_KEY)
  } catch {
    // Without storage no flag was set.
  }
}

/** The UI of `edition`, null when this build has none for it, "reloading" for a stale chunk, or "failed". */
async function importForEdition(
  edition: CogpitEdition,
  reload: boolean,
): Promise<EditionUiModule | null | "reloading" | "failed"> {
  let loaded: EditionUiModule | null
  try {
    loaded = await importEditionUi()
  } catch {
    return reload && reloadOnceForStaleChunk() ? "reloading" : "failed"
  }
  forgetStaleChunkReload()
  return loaded?.edition === edition ? loaded : null
}

async function install(edition: CogpitEdition, required: boolean, reload: boolean): Promise<void> {
  markEditionUiLoading()
  const loaded = await importForEdition(edition, reload)
  if (loaded === "reloading") return
  if (loaded === "failed" && required) {
    forgetStaleChunkReload()
    markEditionUiFailed()
  } else if (loaded === null || loaded === "failed") {
    markEditionUiUnavailable()
  } else {
    installEditionUi(loaded)
  }
}

export interface LoadEditionUiOptions {
  /**
   * `edition` is the connected server's own, whose sign-in and setup screens
   * are its UI: a chunk that cannot be fetched is an error to retry rather than
   * a quiet fall back to personal defaults.
   */
  required?: boolean
}

/**
 * Install the UI of `edition` when this build has it; else the app runs on
 * personal defaults. A required UI that failed waits for {@link retryEditionUi}.
 */
export async function loadEditionUi(edition: CogpitEdition, { required = false }: LoadEditionUiOptions = {}): Promise<void> {
  if (edition === "personal") return
  const state = editionUiState()
  if (state === "installed" || state === "loading" || state === "failed") return
  await install(edition, required, true)
}

/** Ask again for the server's own edition UI after it failed, without reloading the page. */
export async function retryEditionUi(edition: CogpitEdition): Promise<void> {
  if (editionUiState() === "failed") await install(edition, true, false)
}

export interface EditionUiReadiness {
  /** The connected server's own edition UI is settled, so its sign-in and setup screens can render. */
  serverReady: boolean
  /** The UI of every reported edition is installed or known to be unavailable. */
  ready: boolean
  /** The connected server's own edition UI could not be fetched; `retry` asks again. */
  failed: boolean
  retry: () => void
}

function otherThanPersonal(edition: CogpitEdition | null): CogpitEdition | null {
  return edition === "personal" ? null : edition
}

/**
 * Loads the UI for the editions reported so far, null while unknown: the
 * connected server's from its handshake, and the active device's from its
 * identity. The server's own edition comes first, and failing to fetch it is
 * an error. A remote device of another edition falls back to personal defaults.
 */
export function useEditionUiReadiness(
  serverEdition: CogpitEdition | null,
  deviceEdition: CogpitEdition | null,
): EditionUiReadiness {
  const state = useSyncExternalStore(subscribeEditionUi, editionUiState, editionUiState)
  const server = otherThanPersonal(serverEdition)
  const wanted = server ?? otherThanPersonal(deviceEdition)
  const required = server !== null
  useEffect(() => {
    if (wanted !== null) void loadEditionUi(wanted, { required })
  }, [wanted, required])
  const retry = useCallback(() => {
    if (wanted !== null) void retryEditionUi(wanted)
  }, [wanted])
  const settled = state === "installed" || state === "unavailable"
  return {
    serverReady: server === null || settled,
    ready: wanted === null || settled,
    failed: required && state === "failed",
    retry,
  }
}
