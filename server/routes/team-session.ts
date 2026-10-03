import {
  dirs,
  isWithinDir,
  readdir,
  open,
  join,
  stat,
} from "../helpers"
import { lineageFromMeta, teamLeadIn } from "../agents/lineage"
import { authorizeSession, observeAgentTeam, visibilityFor, type VisibilityCheck } from "../edition"
import { matchSubagentToMember, readSessionTeamTags } from "../lib/agentTeamIdentity"
import { sendJson, type UseFn } from "../http"
import {
  authorizeTeam,
  decodeTeamPathSegment,
  readTeamConfig,
  sendInvalidTeamName,
  teamVisibilityFor,
  type TeamConfig,
} from "./agentTeamAccess"

/** List project dir names under PROJECTS_DIR (excluding the memory dir). */
async function listProjectDirNames(): Promise<string[]> {
  const entries = await readdir(dirs.PROJECTS_DIR, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() && e.name !== "memory")
    .map((e) => e.name)
}

/**
 * Resolve team membership for a session that is itself a teammate's own
 * top-level session (new agent-team format). Locates `<sessionId>.jsonl`,
 * reads its teamName/agentName tags, and loads the matching team config.
 */
async function detectTeamFromSessionFile(
  sessionId: string,
  dirNameHint: string | null
): Promise<{ teamName: string; config: TeamConfig; currentMemberName: string | null } | null> {
  const fileName = `${sessionId}.jsonl`

  let candidateDirs: string[]
  try {
    candidateDirs = dirNameHint
      ? [dirNameHint]
      : await listProjectDirNames()
  } catch {
    return null
  }

  for (const dirName of candidateDirs) {
    const filePath = join(dirs.PROJECTS_DIR, dirName, fileName)
    if (!isWithinDir(dirs.PROJECTS_DIR, filePath)) continue
    const tags = await readSessionTeamTags(filePath)
    if (!tags.teamName) continue

    const config = await readTeamConfig(tags.teamName)
    return config && { teamName: tags.teamName, config, currentMemberName: tags.agentName }
  }

  return null
}

/**
 * Find a team member's own top-level session (new agent-team format) by
 * scanning project dirs for `<uuid>.jsonl` files tagged with the given
 * teamName/agentName. Dirs containing the lead session are checked first,
 * and only files modified after the team was created are considered —
 * teammate sessions are always newer than their team. A team's name is
 * reused once it is deleted, so only a session the caller may see is taken.
 */
async function findMemberTopLevelSession(
  teamName: string,
  memberName: string,
  leadSessionId: string,
  teamCreatedAt: number,
  visible: VisibilityCheck,
): Promise<{ dirName: string; fileName: string } | null> {
  let projectDirNames: string[]
  try {
    projectDirNames = await listProjectDirNames()
  } catch {
    return null
  }

  const leadFile = `${leadSessionId}.jsonl`
  const dirFiles: Array<{ dirName: string; files: string[]; hasLead: boolean }> = []
  for (const dirName of projectDirNames) {
    try {
      const names = (await readdir(join(dirs.PROJECTS_DIR, dirName))).filter(
        (f) => f.endsWith(".jsonl")
      )
      const files: Array<{ name: string; mtimeMs: number }> = []
      for (const name of names) {
        if (name === leadFile) continue
        try {
          const s = await stat(join(dirs.PROJECTS_DIR, dirName, name))
          if (s.mtimeMs >= teamCreatedAt) files.push({ name, mtimeMs: s.mtimeMs })
        } catch {
          continue
        }
      }
      // Newest first — the member's session is typically the most recent
      files.sort((a, b) => b.mtimeMs - a.mtimeMs)
      dirFiles.push({ dirName, files: files.map((f) => f.name), hasLead: names.includes(leadFile) })
    } catch {
      continue
    }
  }
  // Members almost always share the lead's project dir — check it first
  dirFiles.sort((a, b) => Number(b.hasLead) - Number(a.hasLead))

  for (const { dirName, files } of dirFiles) {
    for (const f of files) {
      const filePath = join(dirs.PROJECTS_DIR, dirName, f)
      const tags = await readSessionTeamTags(filePath)
      if (tags.teamName !== teamName || tags.agentName !== memberName) continue
      const sessionId = f.slice(0, -".jsonl".length)
      const lineage = lineageFromMeta({ sessionId, parentSessionId: null }, filePath)
      if ((await visible(sessionId, lineage)) !== "hidden") return { dirName, fileName: f }
    }
  }

  return null
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
      const member = config.members?.find((m) => m.name === memberName)

      if (member?.agentType === "team-lead") {
        const entries = await readdir(dirs.PROJECTS_DIR, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name === "memory") continue
          const projectDir = join(dirs.PROJECTS_DIR, entry.name)
          try {
            const files = await readdir(projectDir)
            const targetFile = `${leadSessionId}.jsonl`
            if (files.includes(targetFile)) {
              sendJson(res, 200, { dirName: entry.name, fileName: targetFile })
              return
            }
          } catch { continue }
        }
        sendJson(res, 404, { error: "Lead session not found" })
        return
      }

      // New format first (Claude Code 2.1.19x+): members run as their own
      // top-level sessions tagged with teamName/agentName — exact match.
      const topLevel = await findMemberTopLevelSession(
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

      // Legacy format: members stored as subagent files under the lead
      // session, matched fuzzily by name/prompt snippet.
      const entries = await readdir(dirs.PROJECTS_DIR, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === "memory") continue
        const projectDir = join(dirs.PROJECTS_DIR, entry.name)
        const subagentDir = join(projectDir, leadSessionId, "subagents")

        let subagentFiles: string[]
        try {
          subagentFiles = (await readdir(subagentDir)).filter((f) =>
            f.endsWith(".jsonl")
          )
        } catch {
          continue
        }

        const memberPrompt = member?.prompt || ""
        const promptSnippet = memberPrompt.slice(0, 120)
        const searchTerms = [
          memberName,
          memberName.replace(/-/g, " "),
          ...(promptSnippet
            ? [
                promptSnippet,
                promptSnippet.replace(/"/g, '\\"'),
              ]
            : []),
        ]

        for (const sf of subagentFiles) {
          try {
            const filePath = join(subagentDir, sf)
            const fh = await open(filePath, "r")
            try {
              const buf = Buffer.alloc(16384)
              const { bytesRead } = await fh.read(buf, 0, 16384, 0)
              const raw = buf.subarray(0, bytesRead).toString("utf-8")
              const firstLine = raw.split("\n")[0] || ""

              const matches = searchTerms.some((term) =>
                firstLine.includes(term)
              )
              if (matches) {
                sendJson(res, 200, {
                  dirName: entry.name,
                  fileName: `${leadSessionId}/subagents/${sf}`,
                })
                return
              }
            } finally {
              await fh.close()
            }
          } catch {
            continue
          }
        }
      }

      sendJson(res, 404, { error: "Member session not found" })
    } catch (err) {
      console.error("[team-member-session] Looking up a member's session failed:", err)
      sendJson(res, 500, { error: "Could not look up the member's session" })
    }
  })
}
