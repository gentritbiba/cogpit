import {
  dirs,
  isWithinDir,
  matchSubagentToMember,
  readSessionTeamTags,
  readdir,
  readFile,
  open,
  join,
  stat,
} from "../helpers"
import type { UseFn } from "../http"

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
): Promise<{ teamName: string; config: unknown; currentMemberName: string | null } | null> {
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

    const configPath = join(dirs.TEAMS_DIR, tags.teamName, "config.json")
    if (!isWithinDir(dirs.TEAMS_DIR, configPath)) continue
    try {
      const config = JSON.parse(await readFile(configPath, "utf-8"))
      return {
        teamName: tags.teamName,
        config,
        currentMemberName: tags.agentName,
      }
    } catch {
      return null
    }
  }

  return null
}

/**
 * Find a team member's own top-level session (new agent-team format) by
 * scanning project dirs for `<uuid>.jsonl` files tagged with the given
 * teamName/agentName. Dirs containing the lead session are checked first,
 * and only files modified after the team was created are considered —
 * teammate sessions are always newer than their team.
 */
async function findMemberTopLevelSession(
  teamName: string,
  memberName: string,
  leadSessionId: string,
  teamCreatedAt: number
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
      const tags = await readSessionTeamTags(join(dirs.PROJECTS_DIR, dirName, f))
      if (tags.teamName === teamName && tags.agentName === memberName) {
        return { dirName, fileName: f }
      }
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

    const leadSessionId = url.searchParams.get("leadSessionId")
    const subagentFile = url.searchParams.get("subagentFile")

    if (!leadSessionId) {
      res.statusCode = 400
      res.end(JSON.stringify({ error: "leadSessionId required" }))
      return
    }

    try {
      let teamDirs: string[]
      try {
        const entries = await readdir(dirs.TEAMS_DIR, { withFileTypes: true })
        teamDirs = entries
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      } catch {
        res.statusCode = 404
        res.end(JSON.stringify({ error: "No teams directory" }))
        return
      }

      // Collect ALL matching teams, then pick the most recently created
      let bestMatch: { teamName: string; config: Record<string, unknown>; createdAt: number } | null = null

      for (const teamName of teamDirs) {
        try {
          const configPath = join(dirs.TEAMS_DIR, teamName, "config.json")
          const configRaw = await readFile(configPath, "utf-8")
          const config = JSON.parse(configRaw)

          if (config.leadSessionId !== leadSessionId) continue

          const createdAt = config.createdAt ?? 0
          if (!bestMatch || createdAt > bestMatch.createdAt) {
            bestMatch = { teamName, config, createdAt }
          }
        } catch {
          continue
        }
      }

      if (!bestMatch) {
        // New format (Claude Code 2.1.19x+): the viewed session may itself be
        // a team member's own top-level session, tagged per-line with
        // teamName/agentName. Read its tags and resolve the team from them.
        const dirNameHint = url.searchParams.get("dirName")
        const memberCtx = await detectTeamFromSessionFile(leadSessionId, dirNameHint)
        if (memberCtx) {
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify(memberCtx))
          return
        }
        res.statusCode = 404
        res.end(JSON.stringify({ error: "No team found for this session" }))
        return
      }

      const { teamName: matchedTeamName, config: matchedConfig } = bestMatch
      let currentMemberName: string | null = null

      if (!subagentFile) {
        const lead = (matchedConfig.members as { agentType?: string; name?: string }[])?.find(
          (m) => m.agentType === "team-lead"
        )
        currentMemberName = lead?.name || null
      } else {
        currentMemberName = await matchSubagentToMember(
          leadSessionId,
          subagentFile,
          (matchedConfig.members as Array<{ name: string; agentType: string; prompt?: string }>) || []
        )
      }

      res.setHeader("Content-Type", "application/json")
      res.end(
        JSON.stringify({ teamName: matchedTeamName, config: matchedConfig, currentMemberName })
      )
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(err) }))
    }
  })

  // GET /api/team-member-session/:teamName/:memberName - find a team member's subagent session
  use("/api/team-member-session/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length !== 2) return next()

    const teamName = decodeURIComponent(parts[0])
    const memberName = decodeURIComponent(parts[1])

    try {
      const configPath = join(dirs.TEAMS_DIR, teamName, "config.json")
      const configRaw = await readFile(configPath, "utf-8")
      const config = JSON.parse(configRaw)

      const leadSessionId = config.leadSessionId
      if (!leadSessionId) {
        res.statusCode = 404
        res.end(JSON.stringify({ error: "No lead session ID" }))
        return
      }

      const member = config.members?.find(
        (m: { name: string }) => m.name === memberName
      )

      if (member?.agentType === "team-lead") {
        const entries = await readdir(dirs.PROJECTS_DIR, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name === "memory") continue
          const projectDir = join(dirs.PROJECTS_DIR, entry.name)
          try {
            const files = await readdir(projectDir)
            const targetFile = `${leadSessionId}.jsonl`
            if (files.includes(targetFile)) {
              res.setHeader("Content-Type", "application/json")
              res.end(JSON.stringify({ dirName: entry.name, fileName: targetFile }))
              return
            }
          } catch { continue }
        }
        res.statusCode = 404
        res.end(JSON.stringify({ error: "Lead session not found" }))
        return
      }

      // New format first (Claude Code 2.1.19x+): members run as their own
      // top-level sessions tagged with teamName/agentName — exact match.
      const topLevel = await findMemberTopLevelSession(
        teamName,
        memberName,
        leadSessionId,
        typeof config.createdAt === "number" ? config.createdAt : 0
      )
      if (topLevel) {
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify(topLevel))
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
                res.setHeader("Content-Type", "application/json")
                res.end(
                  JSON.stringify({
                    dirName: entry.name,
                    fileName: `${leadSessionId}/subagents/${sf}`,
                  })
                )
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

      res.statusCode = 404
      res.end(JSON.stringify({ error: "Member session not found" }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(err) }))
    }
  })
}
