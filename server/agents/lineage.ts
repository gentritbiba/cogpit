import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { instanceSessionId, splitInstanceSessionId } from "../../shared/session/instances"
import { orchestrationStore } from "../orchestration/storage"
import { canonicalSessionId } from "../../shared/session/agent-descriptors"
import { isRecord } from "../../shared/objects"
import { dirs } from "../dirs"
import { isWithinDir } from "../pathSafety"
import { findJsonlPath } from "../sessionPaths"
import { storeForPath } from "./index"
import { readTranscriptHead } from "./transcriptHead"
import type { SessionIdentity } from "./types"

/**
 * Which session a child session belongs under. Forks and spawned threads record
 * their parent in their own transcript; an agent-team member records only its
 * team's name, and the team config names the lead.
 */

/**
 * A finding, `"none"` once everything it depends on was read and names nothing,
 * or `"unknown"` when something could not be read yet — gone, mid-write or
 * unreadable. Only a finding or `"none"` is safe to remember.
 */
export type Discovered<T> = T | "none" | "unknown"

/**
 * An agent-team member whose team's config is gone — deleted, or replaced by
 * a later team reusing its name — so its lead can no longer be named. As safe
 * to remember as `"none"`.
 */
export type TeamGone = "teamGone"

export interface DiscoveredParent {
  parentSessionId: string
  source: "transcript" | "team"
}

/** An agent team's lead, as the team's config names it. */
export interface TeamLead {
  sessionId: string
  /** When the team was created, in epoch milliseconds; null when the config does not say. */
  createdAt: number | null
}

/** An agent-team member, as its transcript describes it. */
export interface TeamMember {
  sessionId: string
  teamName: string
  /** When the member's first prompt was written. */
  timestamp: string
}

/** Team configs already read, by team name, for a caller placing several members. */
export type TeamConfigCache = Map<string, Promise<Discovered<TeamLead> | TeamGone>>

/** A parent worth recording: a session id other than the session's own, in the case stores key by. */
function parentOf(sessionId: string, candidate: string | null | undefined): string | null {
  const parentSessionId = candidate ? canonicalSessionId(candidate) : null
  return parentSessionId === canonicalSessionId(sessionId) ? null : parentSessionId
}

declare const serverRead: unique symbol

/**
 * A session's lineage as the server read it from the session's own
 * transcript. The access resolver persists the parent as permanent
 * inheritance, so this must never come from request input: build it only with
 * `lineageFromMeta`, from metadata or inventory the server read itself.
 */
export interface TrustedLineage {
  /** The session described; the resolver ignores the lineage for any other. */
  readonly sessionId: string
  /** Null when the metadata names none — the resolver then reads the transcript. */
  readonly parentSessionId: string | null
  /** The session's own transcript, sparing discovery the lookup by id. */
  readonly filePath?: string
  readonly [serverRead]: true
}

export function lineageFromMeta(
  meta: Pick<SessionIdentity, "sessionId" | "parentSessionId">,
  filePath?: string,
): TrustedLineage {
  const lineage = {
    sessionId: canonicalSessionId(meta.sessionId) ?? meta.sessionId.toLowerCase(),
    parentSessionId: parentOf(meta.sessionId, meta.parentSessionId),
    ...(filePath === undefined ? {} : { filePath }),
  }
  return lineage as TrustedLineage
}

/** The lead a parsed team config names, as written; null when it names none. */
export function teamLeadIn(config: unknown): TeamLead | null {
  if (!isRecord(config) || typeof config.leadSessionId !== "string") return null
  return {
    sessionId: config.leadSessionId,
    createdAt: typeof config.createdAt === "number" ? config.createdAt : null,
  }
}

/** The lead a team's config names; `"teamGone"` once the team is deleted, which is for good. */
export async function readTeamLead(teamName: string, instanceId = "default"): Promise<Discovered<TeamLead> | TeamGone> {
  const instance = instanceId === "default" ? null : orchestrationStore().instances().find((value) => value.id === instanceId)
  const teamsDir = instanceId === "default" ? dirs.TEAMS_DIR : instance ? join(instance.homeDir, "teams") : null
  if (!teamsDir) return "unknown"
  const configPath = join(teamsDir, teamName, "config.json")
  if (!isWithinDir(teamsDir, configPath)) return "none"
  let config: unknown
  try {
    config = JSON.parse(await readFile(configPath, "utf-8"))
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "teamGone" : "unknown"
  }
  const lead = teamLeadIn(config)
  if (!lead) return "none"
  return instanceId === "default" ? lead : { ...lead, sessionId: instanceSessionId(instanceId, splitInstanceSessionId(lead.sessionId).nativeId) }
}

/**
 * The lead a team member belongs under. Team names are reused once a team is
 * deleted, so a config only speaks for a member that started after the team it
 * describes was created: an earlier member's own team is gone.
 */
export async function teamLeadFor(
  member: TeamMember,
  cache?: TeamConfigCache,
): Promise<Discovered<TeamLead> | TeamGone> {
  const startedAt = Date.parse(member.timestamp)
  if (Number.isNaN(startedAt)) return "unknown"
  const { instanceId } = splitInstanceSessionId(member.sessionId)
  const key = instanceId === "default" ? member.teamName : `${instanceId}:${member.teamName}`
  let config = cache?.get(key)
  if (!config) {
    config = readTeamLead(member.teamName, instanceId)
    cache?.set(key, config)
  }
  const lead = await config
  if (typeof lead === "string") return lead
  const sessionId = parentOf(member.sessionId, lead.sessionId)
  if (!sessionId || lead.createdAt === null) return "none"
  if (lead.createdAt > startedAt) return "teamGone"
  return { sessionId, createdAt: lead.createdAt }
}

function recordedParent(sessionId: string, candidate: string | null): DiscoveredParent | "none" {
  const parentSessionId = parentOf(sessionId, candidate)
  return parentSessionId ? { parentSessionId, source: "transcript" } : "none"
}

/**
 * The parent a child session inherits access from, read from its transcript
 * head (and, for agent-team members, the team config). A caller that already
 * resolved the transcript passes its path to skip the lookup by id.
 */
export async function discoverParent(
  sessionId: string,
  knownFilePath?: string,
): Promise<Discovered<DiscoveredParent> | TeamGone> {
  const filePath = knownFilePath ?? await findJsonlPath(sessionId)
  const store = filePath ? storeForPath(filePath) : null
  if (!filePath || !store) return "unknown"
  try {
    if (!store.descriptor.capabilities.agentTeams) {
      const identity = await store.readIdentity(filePath)
      return identity ? recordedParent(sessionId, identity.parentSessionId) : "unknown"
    }
    const meta = await store.readSessionMeta(filePath, await readTranscriptHead(filePath))
    const recorded = recordedParent(sessionId, meta.parentSessionId)
    if (recorded !== "none" || !meta.teamName) return recorded
    const lead = await teamLeadFor({ sessionId, teamName: meta.teamName, timestamp: meta.timestamp })
    return typeof lead === "string" ? lead : { parentSessionId: lead.sessionId, source: "team" }
  } catch {
    return "unknown"
  }
}
