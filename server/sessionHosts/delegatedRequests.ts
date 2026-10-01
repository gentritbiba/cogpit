import type { DelegatedRequest } from "../../shared/contracts/delegatedRequests"
import type { PendingInput } from "../../shared/contracts/pendingInput"
import { deliverNotification } from "../lib/notificationDelivery"
import { sessionsAskingUser } from "../lib/sessionOrigins"
import { hostForOrigin, hostForSession, localHost } from "./index"

/**
 * Questions and approvals from sessions another agent started with their
 * questions routed to the user — typically a task handed to another machine.
 * The watcher gathers what each one is waiting on so the parent session's view
 * can show it, and announces each new remote request once. A local session
 * already announces its own prompts, so only remote ones notify here.
 */

const POLL_MS = 3000
/** Sessions that finished are re-read this rarely, in case a follow-up restarts them. */
const IDLE_POLL_MS = 60_000
/** Delegated sessions older than this are no longer watched. */
const WATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const requests = new Map<string, DelegatedRequest>()
const announced = new Set<string>()
const idleSince = new Map<string, number>()
let started = false
let polling = false

export function listDelegatedRequests(parentSessionId: string): DelegatedRequest[] {
  return [...requests.values()].filter((request) => request.parentSessionId === parentSessionId)
}

function describeRequest(request: PendingInput): string {
  switch (request.kind) {
    case "permission":
      return `${request.toolName}: ${request.summary}`
    case "question":
      return request.questions[0]?.question ?? "Has a question"
    case "plan":
      return "Wants a plan approved"
  }
}

async function navFor(sessionId: string | null) {
  const address = sessionId ? await localHost.address(sessionId) : null
  return { sessionId: address ? sessionId : null, dirName: address?.dirName ?? null }
}

async function announce(request: DelegatedRequest): Promise<void> {
  const fresh = request.waiting.filter((pending) => !announced.has(`${request.sessionId}:${pending.requestId}`))
  if (fresh.length === 0) return
  for (const pending of fresh) announced.add(`${request.sessionId}:${pending.requestId}`)
  if (!request.device) return
  deliverNotification({
    title: `${request.device.name} needs your answer`,
    body: describeRequest(fresh[0]),
    // The answer card lives in the session that handed the task over.
    nav: await navFor(request.parentSessionId),
  }, "permission")
}

export async function pollDelegatedRequests(now = Date.now()): Promise<void> {
  const watched = await sessionsAskingUser(now - WATCH_WINDOW_MS)
  const present = new Set(watched.map(({ sessionId }) => sessionId))
  for (const sessionId of requests.keys()) if (!present.has(sessionId)) requests.delete(sessionId)
  for (const sessionId of idleSince.keys()) if (!present.has(sessionId)) idleSince.delete(sessionId)
  for (const key of announced) if (!present.has(key.slice(0, key.indexOf(":")))) announced.delete(key)

  await Promise.all(watched.map(async ({ sessionId, origin }) => {
    const idle = idleSince.get(sessionId)
    if (idle !== undefined && now - idle < IDLE_POLL_MS) return
    try {
      const host = hostForOrigin(origin) ?? await hostForSession(sessionId)
      const state = await host.state(sessionId)
      if (state.outcome !== "needs_input") {
        requests.delete(sessionId)
        if (state.outcome === "running" || state.outcome === "unreachable") idleSince.delete(sessionId)
        else idleSince.set(sessionId, now)
        return
      }
      idleSince.delete(sessionId)
      const request: DelegatedRequest = {
        sessionId,
        address: requests.get(sessionId)?.address ?? await host.address(sessionId).catch(() => null),
        parentSessionId: origin.parentSessionId ?? null,
        device: host.remote ? { id: host.id, name: host.name } : null,
        waiting: state.waiting,
      }
      requests.set(sessionId, request)
      await announce(request)
    } catch {
      // A device that refuses or fails this poll is retried on the next one.
    }
  }))
}

/** Drop an answered request at once, rather than showing it until the next poll. */
export function markDelegatedRequestAnswered(sessionId: string, requestId: string): void {
  const request = requests.get(sessionId)
  if (request) {
    const waiting = request.waiting.filter((pending) => pending.requestId !== requestId)
    if (waiting.length > 0) requests.set(sessionId, { ...request, waiting })
    else requests.delete(sessionId)
  }
  idleSince.delete(sessionId)
}

/** Picks up a session that was idle as soon as someone sends it more work. */
export function watchDelegatedRequestsOf(sessionId: string): void {
  idleSince.delete(sessionId)
}

export function startDelegatedRequestWatcher(): void {
  if (started) return
  started = true
  const run = () => {
    if (polling) return
    polling = true
    pollDelegatedRequests()
      .catch((error: unknown) => console.error("[delegatedRequests] poll failed:", error))
      .finally(() => {
        polling = false
      })
  }
  setInterval(run, POLL_MS).unref()
  run()
}

export function __resetDelegatedRequestsForTest(): void {
  requests.clear()
  announced.clear()
  idleSince.clear()
}
