/**
 * The guest transport.
 *
 * Deliberately not {@link authFetch}: that helper carries host concerns a guest
 * has no use for (the multi-device prefix, the legacy-token scrub, a 401 that
 * rejects into the host login gate). A guest is always a browser on the share
 * origin holding one HttpOnly cookie, so plain fetch plus the mutation-source
 * header is the whole contract.
 *
 * Mutations name no session. The sessionId lives in the share token, and the
 * server never reads one out of a guest body — so there is nothing here to
 * spoof and nothing to keep in sync.
 */

import type { PermissionDecision, PermissionRequest } from "@/hooks/usePermissionRequests"

export interface SharedSessionInfo {
  sessionId: string
  dirName: string
  fileName: string
  title: string
  provider: "claude" | "codex"
}

/**
 * The host stopped sharing, rotated the passphrase, or turned network access
 * off. Nothing the guest can retry, so the shell moves to a terminal state
 * rather than looping.
 */
export const SHARE_REVOKED_EVENT = "cogpit-share-revoked"

function signalRevoked(): void {
  window.dispatchEvent(new Event(SHARE_REVOKED_EVENT))
}

async function shareFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  headers.set("X-Cogpit-Client", "1")
  const res = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  })
  if (res.status === 401) signalRevoked()
  return res
}

function post(path: string, body?: unknown): Promise<Response> {
  return shareFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })
}

export type SharedSessionProbe =
  | { status: "ok"; info: SharedSessionInfo }
  | { status: "unauthenticated" }
  | { status: "error"; message: string }

/**
 * The first call the shell makes. A 401 here is the ordinary "not logged in
 * yet" answer, so unlike every other guest call it must not be read as the
 * share having been revoked.
 */
export async function probeSharedSession(): Promise<SharedSessionProbe> {
  let res: Response
  try {
    res = await fetch("/api/share/session", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-Cogpit-Client": "1" },
    })
  } catch {
    return { status: "error", message: "Could not reach the server." }
  }
  if (res.status === 401) return { status: "unauthenticated" }
  if (!res.ok) {
    return { status: "error", message: `The server refused the request (${res.status}).` }
  }
  try {
    return { status: "ok", info: await res.json() as SharedSessionInfo }
  } catch {
    return { status: "error", message: "The server sent an unreadable response." }
  }
}

export function sendShareMessage(
  message: string,
  images?: Array<{ data: string; mediaType: string }>,
): Promise<Response> {
  return post("/api/share/send-message", images?.length ? { message, images } : { message })
}

export function interruptShare(): Promise<Response> {
  return post("/api/share/interrupt")
}

export function stopShare(): Promise<Response> {
  return post("/api/share/stop")
}

export async function respondSharePermission(
  requestId: string,
  behavior: PermissionDecision,
): Promise<boolean> {
  const res = await post("/api/share/permission", { requestId, behavior })
  return res.ok
}

/** Resolves rather than throwing, so a caller can fall back to a plain message. */
export async function answerShareQuestion(
  toolUseId: string,
  answers: Record<string, string>,
): Promise<{ ok: boolean; gone: boolean }> {
  try {
    const res = await post("/api/share/answer", { toolUseId, answers })
    return { ok: res.ok, gone: res.status === 404 }
  } catch {
    return { ok: false, gone: false }
  }
}

/**
 * Everything the shared session is blocked on. One endpoint and one poll: the
 * guest is typically on a tunnel, where a second round trip per tick is the
 * expensive part.
 */
export async function fetchSharePending(): Promise<PermissionRequest[] | null> {
  try {
    const res = await shareFetch("/api/share/pending")
    if (!res.ok) return null
    const data = await res.json() as { permissions?: unknown }
    return Array.isArray(data.permissions) ? data.permissions as PermissionRequest[] : []
  } catch {
    return null
  }
}
