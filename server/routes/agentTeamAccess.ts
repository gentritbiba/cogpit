import type { IncomingMessage, ServerResponse } from "node:http"
import { isRecord } from "../../shared/objects"
import { teamLeadIn } from "../agents/lineage"
import {
  authorizeHostWide,
  editionOwnsSignIn,
  mayActHostWide,
  observeAgentTeam,
  visibilityFor,
  type AuthorizedSession,
  type SessionIdRef,
  type VisibleSession,
} from "../edition"
import { dirs, join, readFile } from "../helpers"
import { sendJson } from "../http"

/**
 * Agent teams are reached through their lead's session: whoever may see the
 * lead sees its team, and whoever may interact with it may message its
 * members. A team whose config names no lead belongs to no session, so only
 * whoever may act host-wide reaches it.
 */

/** The fields of a team's config.json the team routes read; the file is the CLI's, so each may be missing. */
export interface TeamConfig {
  name?: string
  description?: string
  createdAt?: number
  members?: Array<{ name?: string; agentType?: string; prompt?: string }>
}

/** A team or member name that names exactly one entry of its directory. */
function isTeamPathSegment(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[/\\\0]/.test(name)
}

/** A URL path segment decoded to a team or member name; null when it is malformed or names no single entry. */
export function decodeTeamPathSegment(segment: string): string | null {
  let name: string
  try {
    name = decodeURIComponent(segment)
  } catch {
    return null
  }
  return isTeamPathSegment(name) ? name : null
}

export function sendInvalidTeamName(res: ServerResponse): void {
  sendJson(res, 400, { error: "Invalid team or member name" })
}

/** A team's config, or null when it is missing, unreadable or not an object. */
export async function readTeamConfig(teamName: string): Promise<TeamConfig | null> {
  if (!isTeamPathSegment(teamName)) return null
  try {
    const config: unknown = JSON.parse(await readFile(join(dirs.TEAMS_DIR, teamName, "config.json"), "utf-8"))
    return isRecord(config) ? config as TeamConfig : null
  } catch {
    return null
  }
}

export interface AuthorizedTeam {
  /** Null for a team with no readable config, which only a caller who may act host-wide reaches. */
  config: TeamConfig | null
  /** The lead session the team was authorized through; null when the config names none. */
  lead: AuthorizedSession | null
}

/** Checks the caller's access to a team's lead session, read from the team's config. */
type AuthorizeLead = (lead: SessionIdRef) => Promise<AuthorizedSession | null>

/**
 * Read a team and check the caller may act on it: `authorizeLead` checks its
 * lead's session, and a team with no lead is host-wide. Null after answering;
 * a member cannot tell a team they may not see from one that does not exist.
 * A team whose lead the caller reached is observed.
 */
export async function authorizeTeam(
  req: IncomingMessage,
  res: ServerResponse,
  teamName: string,
  authorizeLead: AuthorizeLead,
): Promise<AuthorizedTeam | null> {
  const config = await readTeamConfig(teamName)
  const leadSessionId = config && teamLeadIn(config)?.sessionId
  if (!leadSessionId) return authorizeHostWide(req, res) ? { config, lead: null } : null
  const lead = await authorizeLead({ sessionId: leadSessionId, readByServer: true })
  if (lead) observeAgentTeam(teamName)
  return lead && { config, lead }
}

/**
 * `authorizeTeam` for a route that needs the caller's access to a team and
 * not its config. Where no accounts sign in, the one caller reaches every
 * team, so nothing is read and no lead is named.
 */
export async function authorizeTeamAccess(
  req: IncomingMessage,
  res: ServerResponse,
  teamName: string,
  authorizeLead: AuthorizeLead,
): Promise<Pick<AuthorizedTeam, "lead"> | null> {
  return editionOwnsSignIn() ? authorizeTeam(req, res, teamName, authorizeLead) : { lead: null }
}

const HOST_WIDE: VisibleSession = { annotate: async (item) => item }

/**
 * A predicate for team lists: a team is shown with the caller's access to its
 * lead, and one with no lead only to whoever may act host-wide. Marks the
 * request decided.
 */
export function teamVisibilityFor(req: IncomingMessage): (config: TeamConfig) => Promise<VisibleSession | "hidden"> {
  const visible = visibilityFor(req)
  const hostWide = mayActHostWide(req) ? HOST_WIDE : "hidden"
  return async (config) => {
    const lead = teamLeadIn(config)
    return lead ? visible(lead.sessionId) : hostWide
  }
}
