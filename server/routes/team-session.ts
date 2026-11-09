import { basename, dirname } from "node:path"
import { soleDescriptorWhere } from "../../shared/session/agent-descriptors"
import { storeFor } from "../agents"
import { lineageFromMeta, teamLeadIn } from "../agents/lineage"
import { authorizeSession, observeAgentTeam, visibilityFor, type VisibilityCheck } from "../edition"
import { dirs, isWithinDir, join, readdir } from "../helpers"
import { findSubagentOfMember, matchSubagentToMember, readSessionTeamTags } from "../lib/agentTeamIdentity"
import { sendJson, type UseFn } from "../http"
import {
  authorizeTeam,
  decodeTeamPathSegment,
  readTeamConfig,
  sendInvalidTeamName,
  teamVisibilityFor,
  type TeamConfig,
} from "./agentTeamAccess"

const TEAM_AGENT = soleDescriptorWhere((descriptor) => descriptor.capabilities.agentTeams, "agent teams")
const teamStore = () => storeFor(TEAM_AGENT.kind)

/** Tag heads read at once while looking for a member; most are memoized after the first lookup. */
const TAG_READ_BATCH = 16

/** How the UI addresses a transcript under the team agent's projects dir. */
function addressOf(filePath: string): { dirName: string; fileName: string } {
  return { dirName: basename(dirname(filePath)), fileName: basename(filePath) }
}

/**
 * Resolve team membership for a session that is itself a teammate's own
 * top-level session (new agent-team format): read its teamName/agentName
 * tags and load the matching team config.
 */
async function detectTeamFromSessionFile(
  sessionId: string,
  dirNameHint: string | null
): Promise<{ teamName: string; config: TeamConfig; currentMemberName: string | null } | null> {
  let filePath: string | null
  if (dirNameHint) {
    filePath = join(dirs.PROJECTS_DIR, dirNameHint, TEAM_AGENT.sessionFile.name(sessionId))
    if (!isWithinDir(dirs.PROJECTS_DIR, filePath)) return null
  } else {
    filePath = await teamStore().findSessionFile(sessionId)
    if (!filePath) return null
  }
  const tags = await readSessionTeamTags(filePath)
  if (!tags.teamName) return null
  const config = await readTeamConfig(tags.teamName)
  return config && { teamName: tags.teamName, config, currentMemberName: tags.agentName }
}

/**
 * Find a team member's own top-level session (new agent-team format): a
 * transcript tagged with the given teamName/agentName. Candidates come from
 * the session listing, newest first with the lead's project dir ahead of the
 * rest, and only files modified after the team was created count, since a
 * teammate's session is always newer than its team. A team's name is reused
 * once it is deleted, so only a session the caller may see is taken.
 * Also answers where the lead's transcript is, which the same listing holds.
 */
async function findMemberTopLevelSession(
  teamName: string,
  memberName: string,
  leadSessionId: string,
  teamCreatedAt: number,
  visible: VisibilityCheck,
): Promise<{ member: { dirName: string; fileName: string } | null; leadPath: string | null }> {
  const sessions = await teamStore().listTopLevelSessions().catch(() => [])
  const leadFileName = TEAM_AGENT.sessionFile.name(leadSessionId)
  const leadPath = sessions.find((session) => session.fileName === leadFileName)?.filePath ?? null
  const leadDir = leadPath && dirname(leadPath)
  const inLeadDir = []
  const elsewhere = []
  for (const session of [...sessions].sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    if (session.mtimeMs < teamCreatedAt || session.filePath === leadPath) continue
    if (dirname(session.filePath) === leadDir) inLeadDir.push(session)
    else elsewhere.push(session)
  }
  const candidates = [...inLeadDir, ...elsewhere]

  for (let start = 0; start < candidates.length; start += TAG_READ_BATCH) {
    const batch = candidates.slice(start, start + TAG_READ_BATCH)
    const tags = await Promise.all(batch.map((session) => readSessionTeamTags(session.filePath, session)))
    for (let i = 0; i < batch.length; i++) {
      if (tags[i].teamName !== teamName || tags[i].agentName !== memberName) continue
      const { filePath, fileName } = batch[i]
      const sessionId = batch[i].sessionId ?? TEAM_AGENT.sessionFile.sessionId(fileName)
      if (!sessionId) continue
      const lineage = lineageFromMeta({ sessionId, parentSessionId: null }, filePath)
      if ((await visible(sessionId, lineage)) !== "hidden") return { member: addressOf(filePath), leadPath }
    }
  }
  return { member: null, leadPath }
}

export function registerTeamSessionRoutes(use: UseFn) {
  // GET /api/session-team?leadSessionId=xxx[&subagentFile=xxx]
  use("/api/session-team", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const pathParts = url.pathname.split("/").filter(Boolean)
    if (pathParts.length > 0) return next()

    const requestedSessionId = url.searchParams.get("leadSessionId")
    const subagentFile = url.searchParams.get("subagentFile")

    if (!requestedSessionId) {
      sendJson(res, 400, { error: "leadSessionId required" })
      return
    }
    // The viewed session: a lead, or a teammate reached through its lead.
    const viewed = await authorizeSession(req, res, { sessionId: requestedSessionId }, "view")
    if (!viewed) return
    const leadSessionId = viewed.sessionId

    try {
      let teamDirs: string[]
      try {
        const entries = await readdir(dirs.TEAMS_DIR, { withFileTypes: true })
        teamDirs = entries
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      } catch {
        sendJson(res, 404, { error: "No teams directory" })
        return
      }

      // Collect ALL matching teams, then pick the most recently created
      let bestMatch: { teamName: string; config: TeamConfig; createdAt: number } | null = null

      for (const teamName of teamDirs) {
        const config = await readTeamConfig(teamName)
        if (!config || teamLeadIn(config)?.sessionId !== leadSessionId) continue

        const createdAt = config.createdAt ?? 0
        if (!bestMatch || createdAt > bestMatch.createdAt) {
          bestMatch = { teamName, config, createdAt }
        }
      }

      if (!bestMatch) {
        // New format (Claude Code 2.1.19x+): the viewed session may itself be
        // a team member's own top-level session, tagged per-line with
        // teamName/agentName. Read its tags and resolve the team from them.
        // The tags are the agent's to write, so they speak for a team only
        // when the caller may see the lead its config names.
        const dirNameHint = url.searchParams.get("dirName")
        const memberCtx = await detectTeamFromSessionFile(leadSessionId, dirNameHint)
        if (memberCtx && (await teamVisibilityFor(req)(memberCtx.config)) !== "hidden") {
          observeAgentTeam(memberCtx.teamName)
          sendJson(res, 200, memberCtx)
          return
        }
        sendJson(res, 404, { error: "No team found for this session" })
        return
      }

      const { teamName: matchedTeamName, config: matchedConfig } = bestMatch
      observeAgentTeam(matchedTeamName)
      let currentMemberName: string | null = null

      if (!subagentFile) {
        const lead = matchedConfig.members?.find((m) => m.agentType === "team-lead")
        currentMemberName = lead?.name || null
      } else {
        currentMemberName = await matchSubagentToMember(leadSessionId, subagentFile, matchedConfig.members ?? [])
      }

      sendJson(res, 200, { teamName: matchedTeamName, config: matchedConfig, currentMemberName })
    } catch (err) {
      console.error("[session-team] Resolving a session's team failed:", err)
      sendJson(res, 500, { error: "Could not resolve the session's team" })
    }
  })

  // GET /api/team-member-session/:teamName/:memberName - find a team member's subagent session
  use("/api/team-member-session/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length !== 2) return next()

    const teamName = decodeTeamPathSegment(parts[0])
    const memberName = decodeTeamPathSegment(parts[1])
    if (!teamName || !memberName) return sendInvalidTeamName(res)
    const team = await authorizeTeam(req, res, teamName, (lead) => authorizeSession(req, res, lead, "view"))
    if (!team) return
    const { config } = team
    if (!config) {
      sendJson(res, 404, { error: "Team not found" })
      return
    }
    if (!team.lead) {
      sendJson(res, 404, { error: "No lead session ID" })
      return
    }
    const leadSessionId = team.lead.sessionId

    try {
      const members = config.members ?? []
      const member = members.find((m) => m.name === memberName)

      if (member?.agentType === "team-lead") {
        const leadPath = await teamStore().findSessionFile(leadSessionId)
        if (leadPath) sendJson(res, 200, addressOf(leadPath))
        else sendJson(res, 404, { error: "Lead session not found" })
        return
      }

      // New format first (Claude Code 2.1.19x+): members run as their own
      // top-level sessions tagged with teamName/agentName — exact match.
      const { member: topLevel, leadPath } = await findMemberTopLevelSession(
        teamName,
        memberName,
        leadSessionId,
        typeof config.createdAt === "number" ? config.createdAt : 0,
        visibilityFor(req),
      )
      if (topLevel) {
        sendJson(res, 200, topLevel)
        return
      }

      // Legacy format: members stored as sub-agent files under the lead
      // session, matched by the spawn prompt or name on their first line.
      if (leadPath) {
        const subagentFile = await findSubagentOfMember(
          join(dirname(leadPath), leadSessionId, "subagents"),
          memberName,
          member ? members : [...members, { name: memberName }],
        )
        if (subagentFile) {
          sendJson(res, 200, {
            dirName: addressOf(leadPath).dirName,
            fileName: `${leadSessionId}/subagents/${subagentFile}`,
          })
          return
        }
      }

      sendJson(res, 404, { error: "Member session not found" })
    } catch (err) {
      console.error("[team-member-session] Looking up a member's session failed:", err)
      sendJson(res, 500, { error: "Could not look up the member's session" })
    }
  })
}
