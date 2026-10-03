/**
 * Who may do what with a managed browser. Whoever administers the server owns
 * every one. Anyone else owns their own profile — the `default` their
 * sessions' agents open — and the browsers they created from the panel. A
 * browser a session last drove they may drive while they may interact with
 * that session, or watch while they may only view it. The host's own
 * `default`, and anything nothing ties to the caller, stays out of sight.
 *
 * Personal edition administers everything, so none of this narrows it.
 */
import type { IncomingMessage, ServerResponse } from "node:http"
import type { BrowserControl, BrowserSessionInfo } from "../../shared/browser/types"
import {
  authorizeSession,
  browserAccountOf,
  callerBrowserProfile,
  getRequestPrincipal,
  itemVisibilityFor,
  markDecided,
  mayActHostWide,
  sendSessionHidden,
  type ItemVisibility,
} from "../edition"
import { sendJson } from "../http"
import { ErrorCodes } from "../lib/routeError"
import { DEFAULT_BROWSER } from "./paths"
import { creatorOf, driverOf, readRegistry, type BrowserRegistry } from "./registry"

/** What a check asks about the caller, each read once and only when it is needed. */
class Caller {
  readonly administers: boolean
  /** Their own profile; null when theirs is the host's `default`. */
  readonly profile: string | null
  /** The account a browser they create records; null for a caller without one. */
  private readonly account: string | null
  private visibility: ItemVisibility | null = null
  private registry: BrowserRegistry | null = null

  constructor(private readonly req: IncomingMessage) {
    this.administers = mayActHostWide(req)
    this.profile = callerBrowserProfile(req)
    this.account = getRequestPrincipal(req)?.userId ?? null
  }

  owns(name: string): boolean {
    if (this.administers || name === this.profile) return true
    return this.account !== null && creatorOf(name, this.registry ??= readRegistry()) === this.account
  }

  /** Whether they hold at least `needed` on a session; marks the request decided. */
  sees(sessionId: string, needed: "view" | "interact" = "view"): Promise<boolean> {
    this.visibility ??= itemVisibilityFor(this.req)
    return this.visibility(sessionId, needed)
  }

  async control(name: string, driver: string | null): Promise<BrowserControl | null> {
    if (this.owns(name)) return "own"
    if (name === DEFAULT_BROWSER || driver === null) return null
    if (await this.sees(driver, "interact")) return "drive"
    return await this.sees(driver) ? "watch" : null
  }
}

/** The account a browser the caller creates records as its owner, when they have one. */
export function creatorFor(req: IncomingMessage): string | undefined {
  return getRequestPrincipal(req)?.userId
}

/**
 * The browsers the caller may see, each saying what they may do with it,
 * whether it is their own and whose own it is. Their own profile is listed
 * before its first use, as `default` always is; `describe` reads it. A driver
 * session the caller may not see is left out. Marks the request decided.
 */
export async function visibleBrowsers(
  req: IncomingMessage,
  sessions: readonly BrowserSessionInfo[],
  describe: (name: string) => Promise<BrowserSessionInfo>,
): Promise<BrowserSessionInfo[]> {
  markDecided(req)
  const caller = new Caller(req)
  const { profile } = caller
  const all = profile === null || sessions.some((session) => session.name === profile)
    ? sessions
    : [...sessions, await describe(profile)]
  const shown = await Promise.all(all.map(async (info): Promise<BrowserSessionInfo | null> => {
    const control = await caller.control(info.name, info.driverSessionId)
    if (control === null) return null
    const { driverSessionId } = info
    const driverShown = driverSessionId !== null && (caller.administers || await caller.sees(driverSessionId))
    const mine = info.name === profile
    const account = browserAccountOf(info.name)
    return {
      ...info,
      driverSessionId: driverShown ? driverSessionId : null,
      control,
      // Their own browser is their `default`, which never archives.
      ...(mine && { mine: true, archived: false }),
      ...(account !== null && { account }),
    }
  }))
  return shown.filter((info) => info !== null)
}

/** What the caller may do with `name` now, or null when they may not see it. */
export function browserControlFor(req: IncomingMessage, name: string): Promise<BrowserControl | null> {
  return new Caller(req).control(name, name === DEFAULT_BROWSER ? null : driverOf(name))
}

/**
 * Check the caller may `needed` the browser `name`, answering the refusal when
 * not. A browser they cannot see reads as a session they cannot see, and one
 * a session they may only view last drove as that session, refused at their
 * level. Only an owner changes or deletes one: a grant on the session that
 * drove it goes no further than driving it. Marks the request decided.
 */
export async function authorizeBrowser(
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
  needed: Exclude<BrowserControl, "watch">,
): Promise<boolean> {
  markDecided(req)
  if (new Caller(req).owns(name)) return true
  if (needed === "own") {
    sendJson(res, 403, { error: "Only this browser's owner can change or delete it", code: ErrorCodes.FORBIDDEN })
    return false
  }
  const driver = name === DEFAULT_BROWSER ? null : driverOf(name)
  if (driver === null) {
    sendSessionHidden(res, null)
    return false
  }
  return await authorizeSession(req, res, { sessionId: driver, readByServer: true }, "interact") !== null
}

/** The caller's own profile, which like `default` is never removed or archived. */
export function isCallersOwnBrowser(req: IncomingMessage, name: string): boolean {
  return name === callerBrowserProfile(req)
}
