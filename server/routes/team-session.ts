import {
  dirs,
  matchSubagentToMember,
  readdir,
  readFile,
  open,
  join,
} from "../helpers"
import type { UseFn } from "../helpers"

export function registerTeamSessionRoutes(use: UseFn) {
  // GET /api/session-team?leadSessionId=xxx[&subagentFile=xxx]
  // Detect if a session belongs to a team. Returns team config + current member name.
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
      // Read team config to get leadSessionId and member prompt
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

      // If clicking the lead, return their session directly
      if (member?.agentType === "team-lead") {
        // Find lead's session file
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

      // For non-lead members, find their subagent session
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
