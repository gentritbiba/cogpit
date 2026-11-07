import type { IncomingMessage, ServerResponse } from "node:http"
import {
  SESSION_LIST_VERSION_EVENT,
  type SessionListVersionEvent,
} from "../../shared/contracts/sessionList"
import { visibilityFor } from "../edition"
import type { NextFn } from "../http"
import { catalogVersion, subscribeCatalog, type CatalogChangeKind } from "../sessionCatalog"
import { followVersionInputs, stopFollowingVersionInputs } from "./versionInputs"

/** A row that looks different is announced at most this often. */
export const VISIBLE_GAP_MS = 500
/** Size and mtime alone move with every write; they ride along this rarely. */
export const TOUCH_GAP_MS = 15_000
export const HEARTBEAT_MS = 25_000

interface Client {
  res: ServerResponse
  /** Sees no session, so it hears the version once and nothing after. */
  quiet: boolean
}

const clients = new Set<Client>()
let stopFollowing: (() => void) | null = null
let heartbeat: ReturnType<typeof setInterval> | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushAt = Infinity
let lastSentAt = -Infinity
let sentVersion = -1

function versionFrame(version: number): string {
  const event: SessionListVersionEvent = { version }
  return `event: ${SESSION_LIST_VERSION_EVENT}\ndata: ${JSON.stringify(event)}\n\n`
}

function flush(): void {
  flushTimer = null
  flushAt = Infinity
  lastSentAt = Date.now()
  const version = catalogVersion()
  if (version === sentVersion) return
  sentVersion = version
  const frame = versionFrame(version)
  for (const client of clients) if (!client.quiet) client.res.write(frame)
}

function schedule(kind: CatalogChangeKind): void {
  const at = Math.max(Date.now(), lastSentAt + (kind === "visible" ? VISIBLE_GAP_MS : TOUCH_GAP_MS))
  if (at >= flushAt) return
  if (flushTimer) clearTimeout(flushTimer)
  flushAt = at
  flushTimer = setTimeout(flush, at - Date.now())
  flushTimer.unref?.()
}

function follow(): void {
  const unsubscribe = subscribeCatalog((change) => schedule(change.kind))
  followVersionInputs()
  heartbeat = setInterval(() => {
    for (const client of clients) client.res.write(": heartbeat\n\n")
  }, HEARTBEAT_MS)
  heartbeat.unref?.()
  sentVersion = catalogVersion()
  stopFollowing = () => {
    unsubscribe()
    stopFollowingVersionInputs()
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    flushAt = Infinity
  }
}

function leave(client: Client): void {
  if (!clients.delete(client) || clients.size > 0) return
  stopFollowing?.()
  stopFollowing = null
}

/**
 * GET /api/session-list/events — the session list's version, on connect and
 * whenever a list could read differently. It names no session: a client
 * revalidates its own lists with `If-None-Match`.
 */
export function handleSessionListEvents(req: IncomingMessage, res: ServerResponse, next: NextFn): void {
  if (req.method !== "GET") return next()
  if (req.url && !req.url.startsWith("?") && !req.url.startsWith("/?") && req.url !== "/" && req.url !== "") return next()

  const quiet = visibilityFor(req).nothing
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  })
  // The hub proxy gives up on a device that sends nothing for 7 s.
  res.flushHeaders()

  const client: Client = { res, quiet }
  if (clients.size === 0) follow()
  clients.add(client)
  res.write(versionFrame(catalogVersion()))
  res.once("close", () => leave(client))
}

export function __resetSessionListEventsForTest(): void {
  for (const client of [...clients]) leave(client)
  lastSentAt = -Infinity
  sentVersion = -1
}
