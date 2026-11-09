/**
 * The open controller: the one way a session gets onto the screen.
 *
 * Every open path (dashboard and sidebar, command palette, URL and popstate,
 * preview, team member, copy, reload, resync, share, new-session finalize)
 * calls `openSession`. Each open takes the controller's current token, and a
 * result whose token is no longer current is never committed, so a slow open
 * can never replace the session the user moved on to.
 *
 * Loads are the turn-aligned tail of the transcript, parsed in the worker and
 * kept in `sessionCache`. Concurrent loads of one transcript share a single
 * request and parse, whether a hover prefetch or a click started it.
 */

import type { Dispatch } from "react"
import type { SessionView } from "../../shared/session/sessionDigest"
import type { SessionAction } from "@/hooks/useSessionState"
import { nextLoadId, type SessionSource } from "@/lib/sessionSource"
import { authFetch } from "@/lib/auth"
import { sessionCache, sessionCacheKey } from "@/lib/sessionCache"
import { agentKindForDirName } from "@/lib/agents"
import { formatFor } from "../../shared/session/agents"
import { linesBeforeFirstTurn } from "../../shared/session/pageCuts"
import { scopeParsedSession, splitInstanceDirName } from "../../shared/session/instances"
import { RESULT_PROJECTION } from "../../shared/contracts/toolResults"

export interface SessionAddress {
  dirName: string
  fileName: string
}

export type OpenReason = "click" | "url" | "team" | "copy" | "finalize" | "share" | "reload"

export interface LoadedSession {
  parsed: SessionView
  source: SessionSource
}

export interface TailResponse {
  headerLines: string[]
  tailLines: string[]
  byteOffset: number
  totalSize: number
  hasMore: boolean
  /** Present when the server cut the page on turn boundaries; older servers send a line page. */
  unit?: "turns"
  /** The byte after the page's last complete line. Older servers leave it out. */
  end?: number
}

type Parse = (text: string) => Promise<SessionView>

/** An address, or a lookup that resolves one (a team member, a preview id, a new copy). */
export type OpenTarget = SessionAddress | ((signal: AbortSignal) => Promise<SessionAddress>)

export interface OpenRequest {
  reason: Exclude<OpenReason, "reload">
  /** Puts the load on screen. Runs only while this open is still the current one. */
  commit: (loaded: LoadedSession) => void
  /** Turns a failed load into one to show anyway. */
  recover?: (error: unknown, address: SessionAddress) => LoadedSession
}

/** An open that failed while current throws; one that lost to a later open resolves "superseded". */
export type OpenOutcome = "opened" | "superseded"

export interface SessionController {
  openSession(target: OpenTarget, request: OpenRequest): Promise<OpenOutcome>
  /** Warm the cache for a likely next open. Best-effort and never aborted. */
  prefetchSession(address: SessionAddress): void
  /**
   * Re-read the session on screen from disk, dropping the history paged in
   * above it. A failed read is retried after `RELOAD_RETRY_DELAYS_MS` while
   * the session stays on screen. A no-op with nothing on screen or while
   * another open is landing. A call during a reload joins it, and cuts short
   * a wait before its next retry unless it passes `keepBackoff`, as the live
   * stream's repeated resets do.
   */
  reloadCurrent(options?: { keepBackoff?: boolean }): Promise<void>
  /** The user left the session on screen; nothing pending may land after this. */
  leave(): void
}

/** The waits before each retry of a failed reload; after the last one it gives up. */
export const RELOAD_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

/** Turns a tail page asks for; the server stops earlier at its byte budget. */
export const TAIL_TURNS = 10

/** Opens that read the transcript from disk even when it is cached. */
const FRESH: ReadonlySet<OpenReason> = new Set(["reload", "finalize", "share"])

function tailUrl({ dirName, fileName }: SessionAddress): string {
  return `/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(fileName)}?tail=${TAIL_TURNS}&unit=turns&projection=${RESULT_PROJECTION}`
}

/**
 * A line page with what goes in front of it. `headerLines` are the file's
 * first lines and `prologue` those before its first turn. Below a gap
 * (`hasMore`), only the prologue goes in front: the rest of the header is a
 * turn far above the page. A page that reaches the head joins the whole
 * header, less the lines of it the page repeats.
 */
export function joinLinePage(
  headerLines: readonly string[],
  prologue: readonly string[],
  lines: readonly string[],
  hasMore: boolean,
): string[] {
  if (hasMore) return [...prologue, ...lines]
  for (let overlap = Math.min(headerLines.length, lines.length); overlap > 0; overlap--) {
    if (headerLines.slice(-overlap).every((line, index) => lines[index] === line)) return [...headerLines, ...lines.slice(overlap)]
  }
  return [...headerLines, ...lines]
}

/**
 * Header plus tail. A turn page's header holds only the lines before the
 * first turn, so the two are joined exactly as sent. An older server's line
 * page sends the file's first lines as its header, which can hold the first
 * turn (see `joinLinePage`).
 */
function tailText(data: TailResponse, dirName: string): string {
  if (data.unit === "turns") return [...data.headerLines, ...data.tailLines].join("\n")
  const prologue = linesBeforeFirstTurn(formatFor(agentKindForDirName(dirName)), data.headerLines)
  return joinLinePage(data.headerLines, prologue, data.tailLines, data.hasMore).join("\n")
}

// ── Shared loads ─────────────────────────────────────────────────────────────

interface Flight {
  key: string
  /** Resolves null when the device or identity changed while it ran. */
  promise: Promise<LoadedSession | null>
  abort: AbortController
  /** Opens waiting on this load. */
  holders: number
  /** A prefetch waits on it, so it always runs to the end. */
  pinned: boolean
  /** The response is in; what is left is the parse, which is worth caching. */
  fetched: boolean
}

const flights = new Map<string, Flight>()

function startFlight(key: string, address: SessionAddress, parse: Parse, fresh: boolean, background: boolean): Flight {
  const { dirName, fileName } = address
  const abort = new AbortController()
  const flight: Flight = { key, abort, holders: 0, pinned: false, fetched: false, promise: Promise.resolve(null) }
  flight.promise = (async () => {
    try {
      if (fresh) sessionCache.evict(dirName, fileName)
      const res = await authFetch(tailUrl(address), { background, signal: abort.signal })
      if (!res.ok) throw new Error(`Failed to load session (${res.status})`)
      const data: TailResponse = await res.json()
      flight.fetched = true
      const parsed = scopeParsedSession(await parse(tailText(data, dirName)), splitInstanceDirName(dirName).instanceId)
      // Never write one device's or identity's transcript under another's key.
      if (sessionCacheKey(dirName, fileName) !== key) {
        sessionCache.discard(parsed)
        return null
      }
      // A load that finished first, which a live stream may have advanced since, wins.
      const raced = fresh ? undefined : sessionCache.get(dirName, fileName)
      if (raced) {
        sessionCache.discard(parsed)
        return { parsed: raced.parsed, source: raced.source }
      }
      const source: SessionSource = {
        dirName,
        fileName,
        agentKind: agentKindForDirName(dirName),
        watchOffset: data.end ?? data.totalSize,
        loadId: nextLoadId(),
      }
      sessionCache.set(parsed, source, data.byteOffset, data.hasMore)
      return { parsed, source }
    } finally {
      forget(flight)
    }
  })()
  flights.set(key, flight)
  return flight
}

function forget(flight: Flight): void {
  if (flights.get(flight.key) === flight) flights.delete(flight.key)
}

/** A fresh load never joins one that may have read the transcript before it changed. */
function joinFlight(address: SessionAddress, parse: Parse, fresh: boolean, background: boolean): Flight {
  const key = sessionCacheKey(address.dirName, address.fileName)
  const running = fresh ? undefined : flights.get(key)
  return running ?? startFlight(key, address, parse, fresh, background)
}

/** Stops the request once no open waits on it; a load already past the network finishes into the cache. */
function release(flight: Flight): void {
  flight.holders -= 1
  if (flight.holders > 0 || flight.pinned || flight.fetched) return
  forget(flight)
  flight.abort.abort()
}

// ── Controller ───────────────────────────────────────────────────────────────

interface PendingOpen {
  lookup: AbortController
  flight: Flight | null
}

export function createSessionController({
  parse,
  dispatch,
}: {
  parse: Parse
  /** Receives the reload that `reloadCurrent` lands. */
  dispatch: Dispatch<SessionAction>
}): SessionController {
  let token = 0
  let pending: PendingOpen | null = null
  /** The session the last committed open put on screen. */
  let shown: SessionAddress | null = null
  /** This shell's screen in the cache, which holds the view it shows. */
  const screen = {}
  let reloading: Promise<void> | null = null
  /** Ends the wait before the reload's next retry. */
  let retryNow: (() => void) | null = null

  const dropPending = () => {
    if (!pending) return
    pending.lookup.abort()
    if (pending.flight) release(pending.flight)
    pending = null
  }

  async function open(
    target: OpenTarget,
    reason: OpenReason,
    commit: (loaded: LoadedSession) => void,
    recover?: OpenRequest["recover"],
  ): Promise<OpenOutcome> {
    dropPending()
    const mine = ++token
    const self: PendingOpen = { lookup: new AbortController(), flight: null }
    pending = self
    const isCurrent = () => token === mine

    const land = (address: SessionAddress, loaded: LoadedSession): OpenOutcome => {
      pending = null
      shown = address
      sessionCache.show(screen, { ...address, view: loaded.parsed })
      commit(loaded)
      return "opened"
    }

    let address: SessionAddress
    try {
      address = typeof target === "function" ? await target(self.lookup.signal) : target
    } catch (error) {
      if (!isCurrent()) return "superseded"
      pending = null
      throw error
    }
    if (!isCurrent()) return "superseded"

    if (!FRESH.has(reason)) {
      const hit = sessionCache.get(address.dirName, address.fileName)
      if (hit) return land(address, { parsed: hit.parsed, source: hit.source })
    }

    const flight = joinFlight(address, parse, FRESH.has(reason), false)
    flight.holders += 1
    self.flight = flight
    let loaded: LoadedSession | null
    try {
      loaded = await flight.promise
    } catch (error) {
      if (!isCurrent()) return "superseded"
      release(flight)
      pending = null
      if (!recover) throw error
      return land(address, recover(error, address))
    }
    if (!isCurrent()) return "superseded"
    release(flight)
    if (!loaded) {
      pending = null
      return "superseded"
    }
    return land(address, loaded)
  }

  async function reload(address: SessionAddress): Promise<void> {
    for (const delay of [...RELOAD_RETRY_DELAYS_MS, null]) {
      try {
        await open(address, "reload", ({ parsed, source }) => {
          dispatch({ type: "RELOAD_SESSION_CONTENT", session: parsed, source })
        })
        return
      } catch {
        // The session already on screen stays there.
      }
      if (delay === null) return
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay)
        retryNow = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      retryNow = null
      // Another open took over the screen, or the user left it.
      if (pending || shown !== address) return
    }
  }

  return {
    openSession: (target, { reason, commit, recover }) => open(target, reason, commit, recover),

    prefetchSession(address) {
      if (sessionCache.get(address.dirName, address.fileName)) return
      const flight = joinFlight(address, parse, false, true)
      flight.pinned = true
      flight.promise.catch(() => {
        // Best-effort: the click that follows reports a load that keeps failing.
      })
    },

    reloadCurrent(options) {
      if (reloading) {
        if (!options?.keepBackoff) retryNow?.()
        return reloading
      }
      if (pending || !shown) return Promise.resolve()
      reloading = reload(shown).finally(() => { reloading = null })
      return reloading
    },

    leave() {
      dropPending()
      token += 1
      shown = null
      sessionCache.show(screen, null)
    },
  }
}
