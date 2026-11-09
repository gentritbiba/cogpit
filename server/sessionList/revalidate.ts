import { createHash, randomUUID } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import { SESSION_LIST_EPOCH_HEADER, SESSION_LIST_VERSION_HEADER } from "../../shared/contracts/sessionList"
import { getRequestPrincipal } from "../edition"
import { catalogVersion } from "../sessionCatalog"

/** This server run: list versions start again from 0 in every one. */
export const LIST_EPOCH = randomUUID()

/** A list answer for one caller: its JSON body and the headers that describe it. */
export interface ListBody {
  headers: Readonly<Record<string, string>>
  body: string
}

interface ListResponse extends ListBody {
  /** The list version the body was built at. */
  version: number
}

/** Weak, since compression re-encodes the bytes. The headers count: a 304 keeps them too. */
function entityTag({ headers, body }: ListBody): string {
  const hash = createHash("sha1")
  for (const name of Object.keys(headers).sort()) hash.update(`${name}:${headers[name]}\n`)
  return `W/"${hash.update(body).digest("base64url")}"`
}

function notModified(req: IncomingMessage, tag: string): boolean {
  const header = req.headers["if-none-match"]
  if (typeof header !== "string") return false
  const opaque = tag.slice(2)
  return header.split(",").some((candidate) => {
    const value = candidate.trim()
    return value === "*" || value.replace(/^W\//, "") === opaque
  })
}

/** Answers with the body, or 304 when the caller already holds it. */
export function sendListResponse(req: IncomingMessage, res: ServerResponse, response: ListResponse): void {
  const tag = entityTag(response)
  res.setHeader("ETag", tag)
  res.setHeader(SESSION_LIST_VERSION_HEADER, String(response.version))
  res.setHeader(SESSION_LIST_EPOCH_HEADER, LIST_EPOCH)
  for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value)
  if (notModified(req, tag)) {
    res.statusCode = 304
    res.end()
    return
  }
  res.statusCode = 200
  res.setHeader("Content-Type", "application/json")
  res.end(response.body)
}

interface Build {
  promise: Promise<ListResponse>
  waiting: number
  controller: AbortController
}

const builds = new Map<string, Build>()
/** Time-based row fields (idle archiving, the agents' write window) never outlive this in a shared build. */
const SHARE_WINDOW_MS = 1_000
let unshared = 0

/**
 * Who a build is for: callers with the same principal see the same list. A
 * caller without one shares only when it sees every session.
 */
function audience(req: IncomingMessage, seesEverything: boolean): string {
  const principal = getRequestPrincipal(req)
  if (principal) return `${principal.userId}\0${principal.role}`
  return seesEverything ? "*" : `unshared:${unshared++}`
}

/**
 * Runs `build` once for every request asking the same thing of the same list
 * version at the same time. The build is aborted once every request waiting on
 * it has gone; a request that went resolves to null.
 */
export function sharedListBuild(
  req: IncomingMessage,
  res: ServerResponse,
  request: { route: string; query: string; seesEverything: boolean },
  build: (signal: AbortSignal) => Promise<ListBody>,
): Promise<ListResponse | null> {
  const version = catalogVersion()
  const key = [
    request.route,
    request.query,
    audience(req, request.seesEverything),
    version,
    Math.floor(Date.now() / SHARE_WINDOW_MS),
  ].join("\n")
  let shared = builds.get(key)
  if (!shared) {
    const controller = new AbortController()
    const promise = build(controller.signal).then((body) => ({ ...body, version }))
    const entry: Build = { promise, waiting: 0, controller }
    builds.set(key, entry)
    const settle = () => {
      if (builds.get(key) === entry) builds.delete(key)
    }
    promise.then(settle, settle)
    shared = entry
  }
  const entry = shared
  entry.waiting += 1
  let left = false
  const leave = () => {
    if (res.writableEnded || left) return
    left = true
    entry.waiting -= 1
    if (entry.waiting > 0) return
    entry.controller.abort()
    if (builds.get(key) === entry) builds.delete(key)
  }
  res.once("close", leave)
  return entry.promise.then(
    (response) => {
      res.off("close", leave)
      return left ? null : response
    },
    (error: unknown) => {
      res.off("close", leave)
      if (left) return null
      throw error
    },
  )
}

export function __resetListBuildsForTest(): void {
  builds.clear()
  unshared = 0
}
