import type { IncomingMessage, ServerResponse } from "node:http"
import { basename, dirname } from "node:path"
import {
  canIssueBrowserSession,
  CODEX_SESSIONS_DIR,
  encodeCodexDirName,
  findJsonlPath,
  getSessionMeta,
  hasTrustedMutationSource,
  isCodexFilePath,
  isRateLimited,
  resolveSessionFilePath,
} from "../helpers"
import { sendJson, withJsonBody, type UseFn } from "../http"
import { getConfig } from "../config"
import { getDummyHash, verifyRemotePassword } from "../password-verify"
import { isTeamEdition } from "../team/edition"
import {
  countShareGuests,
  createShareToken,
  revokeShareTokensForSession,
  setShareCookie,
} from "../security"
import {
  createShare,
  getShareWithHash,
  listShares,
  removeShare,
  rotateSharePassword,
  type PublicShare,
} from "../share/registry"

/**
 * Host API for sharing a session: create, list, rotate, revoke.
 *
 * Guests never reach any of this — the allowlist denies /api/shares outright,
 * and the guest namespace lives in ./share-guest.ts. The only endpoint here a
 * guest touches is the login, /api/share/verify, which is public because it is
 * where a guest whose token expired gets a new one.
 */

/** A share as the host UI sees it: registry fields plus live, derived ones. */
interface HostShare extends PublicShare {
  title: string
  guests: number
}

/**
 * Team edition replaces the network password with per-user credentials, so its
 * remote surface is always on. Personal edition gates remote access on
 * networkAccess, and a share is remote access — issuing one while that switch
 * is off would quietly reopen the door it closed.
 */
function remoteAccessEnabled(): boolean {
  return isTeamEdition() || getConfig()?.networkAccess === true
}

function stringField(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | null | undefined)?.[key]
  return typeof value === "string" ? value.trim() : ""
}

/**
 * The (dirName, fileName) pair the session routes address this transcript by.
 * Codex rollouts are addressed by an encoded cwd plus a path relative to the
 * rollout root; Claude transcripts by their project directory and file name.
 */
async function addressOf(
  filePath: string,
): Promise<{ dirName: string; fileName: string } | null> {
  if (!isCodexFilePath(filePath)) {
    return { dirName: basename(dirname(filePath)), fileName: basename(filePath) }
  }
  const meta = await getSessionMeta(filePath).catch(() => null)
  if (!meta?.cwd) return null
  const relative = filePath.slice(CODEX_SESSIONS_DIR.length + 1).split(/[\\/]/).join("/")
  return { dirName: encodeCodexDirName(meta.cwd), fileName: relative }
}

/**
 * Resolve what a sessionId may be shared as. The client sends only the
 * sessionId: a client that could name the file could point a share at any
 * JSONL on disk. The address is then required to round-trip back to the same
 * file, so the record can only ever name a transcript the session routes would
 * have served anyway.
 */
async function resolveShareTarget(
  sessionId: string,
): Promise<{ dirName: string; fileName: string } | null> {
  const filePath = await findJsonlPath(sessionId)
  if (!filePath) return null

  const address = await addressOf(filePath)
  if (!address) return null

  const resolved = await resolveSessionFilePath(address.dirName, address.fileName)
  return resolved === filePath ? address : null
}

/** Human label for a shared session, empty when the transcript cannot be read. */
export async function sessionTitle(dirName: string, fileName: string): Promise<string> {
  const filePath = await resolveSessionFilePath(dirName, fileName).catch(() => null)
  if (!filePath) return ""
  const meta = await getSessionMeta(filePath).catch(() => null)
  if (!meta) return ""
  return meta.aiTitle || meta.name || meta.slug || meta.firstUserMessage || ""
}

async function toHostShare(share: PublicShare): Promise<HostShare> {
  return {
    ...share,
    title: await sessionTitle(share.dirName, share.fileName),
    guests: countShareGuests(share.sessionId),
  }
}

async function handleCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  withJsonBody(req, res, async (body) => {
    if (!remoteAccessEnabled()) {
      sendJson(res, 409, {
        error: "Turn on network access before sharing a session",
      })
      return
    }

    const sessionId = stringField(body, "sessionId")
    if (!sessionId) {
      sendJson(res, 400, { error: "sessionId is required" })
      return
    }

    const target = await resolveShareTarget(sessionId)
    if (!target) {
      sendJson(res, 404, { error: "Session not found" })
      return
    }

    const issued = await createShare({ sessionId, ...target })
    // The old passphrase is already dead; tokens minted from it must die with
    // it, or re-sharing would leave the previous guest list intact.
    revokeShareTokensForSession(sessionId)

    sendJson(res, 200, {
      url: `/shared/${encodeURIComponent(sessionId)}`,
      passphrase: issued.passphrase,
      share: await toHostShare(issued.share),
    })
  }, { allowEmpty: true })
}

async function handleList(res: ServerResponse): Promise<void> {
  sendJson(res, 200, await Promise.all(listShares().map(toHostShare)))
}

async function handleRegenerate(res: ServerResponse, sessionId: string): Promise<void> {
  const issued = await rotateSharePassword(sessionId)
  if (!issued) {
    sendJson(res, 404, { error: "Session is not shared" })
    return
  }
  revokeShareTokensForSession(sessionId)
  sendJson(res, 200, { passphrase: issued.passphrase })
}

async function handleRemove(res: ServerResponse, sessionId: string): Promise<void> {
  if (!await removeShare(sessionId)) {
    sendJson(res, 404, { error: "Session is not shared" })
    return
  }
  revokeShareTokensForSession(sessionId)
  sendJson(res, 200, { ok: true })
}

/**
 * One answer for every failed login. Which session is shared, whether the
 * passphrase was close, and whether the share was revoked mid-flight are all
 * the same sentence, so the endpoint cannot be used to enumerate shares.
 */
function rejectLogin(res: ServerResponse): void {
  sendJson(res, 401, { error: "Invalid link or passphrase" })
}

async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("Cache-Control", "no-store")

  if (!hasTrustedMutationSource(req)) {
    sendJson(res, 403, { error: "Untrusted request source" })
    return
  }

  if (req.headers["x-cogpit-client"] === "1" && !canIssueBrowserSession(req)) {
    sendJson(res, 426, {
      error: "Secure HTTPS is required to open a shared session. Use the tunnel URL.",
    })
    return
  }

  // Before any scrypt work: this endpoint is public and unauthenticated, so
  // without the limiter it is a passphrase brute-force oracle.
  if (isRateLimited(req)) {
    sendJson(res, 429, { error: "Too many attempts. Try again in 1 minute." })
    return
  }

  if (!remoteAccessEnabled()) {
    sendJson(res, 403, { error: "Network access is disabled" })
    return
  }

  withJsonBody(req, res, async (body) => {
    const sessionId = stringField(body, "sessionId")
    const passphrase = stringField(body, "passphrase")

    // Captured before the derivation: getShareWithHash hands back the live
    // record, and a rotation or revocation landing during those ~95ms would
    // otherwise authenticate against a hash that no longer exists.
    const expectedHash = (sessionId ? getShareWithHash(sessionId) : undefined)?.passwordHash

    const verification = await verifyRemotePassword(passphrase, expectedHash ?? getDummyHash())
    if (verification === "busy") {
      sendJson(res, 429, { error: "Authentication is busy. Try again shortly." })
      return
    }
    if (verification !== "valid" || expectedHash === undefined) {
      rejectLogin(res)
      return
    }
    if (getShareWithHash(sessionId)?.passwordHash !== expectedHash) {
      rejectLogin(res)
      return
    }

    setShareCookie(
      res,
      createShareToken(
        sessionId,
        req.socket.remoteAddress || "unknown",
        req.headers["user-agent"],
      ),
    )
    // Cookie only. A guest is always a browser, and a token in the body would
    // be readable by any script on the page.
    sendJson(res, 200, { valid: true })
  }, { allowEmpty: true })
}

export function registerShareRoutes(use: UseFn) {
  use("/api/share/verify", (req, res, next) => {
    if (req.method !== "POST") return next()
    return handleLogin(req, res)
  })

  use("/api/shares", (req, res, next) => {
    const url = req.url ?? ""
    const path = url.split(/[?#]/)[0]
    const method = req.method ?? "GET"

    if (path === "" || path === "/") {
      if (method === "GET") return handleList(res)
      if (method === "POST") return handleCreate(req, res)
      return next()
    }

    const regenerate = path.match(/^\/([^/]+)\/regenerate$/)
    if (method === "POST" && regenerate) {
      return handleRegenerate(res, decodeURIComponent(regenerate[1]))
    }

    const single = path.match(/^\/([^/]+)$/)
    if (method === "DELETE" && single) {
      return handleRemove(res, decodeURIComponent(single[1]))
    }

    return next()
  })
}
