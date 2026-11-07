import { soleDescriptorWhere } from "../../shared/session/agent-descriptors"
import {
  authorizeSession,
  authorizeStreamSession,
  handPrompt,
  observeAgentTeam,
} from "../edition"
import {
  dirs,
  readdir,
  readFile,
  writeFile,
  join,
  watch,
} from "../helpers"
import { statSync } from "node:fs"
import { sendJson, withJsonBody, type UseFn } from "../http"
import {
  authorizeTeam,
  authorizeTeamAccess,
  decodeTeamPathSegment,
  readTeamConfig,
  sendInvalidTeamName,
  teamVisibilityFor,
} from "./agentTeamAccess"

const TEAM_AGENT = soleDescriptorWhere((descriptor) => descriptor.capabilities.agentTeams, "agent teams").kind

/** Append a message from the user to a member's inbox file, creating it when missing. */
async function appendToInbox(inboxPath: string, message: string): Promise<void> {
  let inbox: unknown[] = []
  try {
    const raw = await readFile(inboxPath, "utf-8")
    inbox = JSON.parse(raw)
    if (!Array.isArray(inbox)) inbox = []
  } catch { /* file doesn't exist yet */ }

  inbox.push({
    from: "user",
    text: message,
    timestamp: new Date().toISOString(),
    read: false,
  })
  await writeFile(inboxPath, JSON.stringify(inbox, null, 2), "utf-8")
}

const UPDATE_DEBOUNCE_MS = 500

interface TeamWatch {
  listeners: Set<() => void>
  /** Re-open watchers whose directory appeared, vanished or was replaced since they opened. */
  refresh(): void
  close(): void
}

/** One pair of watchers per team, shared by every stream open on it. */
const teamWatches = new Map<string, TeamWatch>()

function dirIdentity(dir: string): number | null {
  try {
    return statSync(dir).ino
  } catch {
    return null
  }
}

/**
 * Hear about changes to a team's config, inboxes and tasks, debounced. The
 * watchers open with the first subscriber and close with the last.
 */
function subscribeToTeam(teamName: string, onUpdate: () => void): () => void {
  let entry = teamWatches.get(teamName)
  if (!entry) {
    const listeners = new Set<() => void>()
    const watchers = new Map<string, { watcher: ReturnType<typeof watch>; ino: number | null }>()
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    const changed = () => {
      // The tasks dir is often created after the team is.
      watchMissing()
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        // A change to a running team is often a member joining.
        observeAgentTeam(teamName)
        for (const listener of listeners) listener()
      }, UPDATE_DEBOUNCE_MS)
    }
    const forget = (dir: string) => {
      watchers.get(dir)?.watcher.close()
      watchers.delete(dir)
    }
    const watchMissing = () => {
      for (const dir of [join(dirs.TEAMS_DIR, teamName), join(dirs.TASKS_DIR, teamName)]) {
        if (watchers.has(dir)) continue
        try {
          const watcher = watch(dir, { recursive: true }, changed)
          watcher.on("error", () => { if (watchers.get(dir)?.watcher === watcher) forget(dir) })
          watchers.set(dir, { watcher, ino: dirIdentity(dir) })
        } catch { /* dir may not exist */ }
      }
    }
    watchMissing()
    entry = {
      listeners,
      refresh: () => {
        for (const [dir, { ino }] of watchers) {
          if (dirIdentity(dir) !== ino) forget(dir)
        }
        watchMissing()
      },
      close: () => {
        for (const dir of [...watchers.keys()]) forget(dir)
        if (debounceTimer) clearTimeout(debounceTimer)
      },
    }
    teamWatches.set(teamName, entry)
  } else {
    entry.refresh()
  }
  const shared = entry
  shared.listeners.add(onUpdate)
  return () => {
    if (!shared.listeners.delete(onUpdate) || shared.listeners.size > 0) return
    shared.close()
    if (teamWatches.get(teamName) === shared) teamWatches.delete(teamName)
  }
}

export function registerTeamRoutes(use: UseFn) {
  // GET /api/teams - list all teams with task progress summary
  use("/api/teams", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const pathParts = url.pathname.split("/").filter(Boolean)
    if (pathParts.length > 0) return next()

    const visibleTeam = teamVisibilityFor(req)
    try {
      let teamDirs: string[]
      try {
        const entries = await readdir(dirs.TEAMS_DIR, { withFileTypes: true })
        teamDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
      } catch {
        sendJson(res, 200, [])
        return
      }

      const teams = []
      for (const teamName of teamDirs) {
        try {
          const config = await readTeamConfig(teamName)
          if (!config) continue
          const lead = await visibleTeam(config)
          if (lead === "hidden") continue
          observeAgentTeam(teamName)

          const taskSummary = { total: 0, completed: 0, inProgress: 0, pending: 0 }
          try {
            const taskDir = join(dirs.TASKS_DIR, teamName)
            const taskFiles = await readdir(taskDir)
            for (const tf of taskFiles.filter((f) => f.endsWith(".json"))) {
              try {
                const taskRaw = await readFile(join(taskDir, tf), "utf-8")
                const task = JSON.parse(taskRaw)
                if (task.status === "deleted") continue
                taskSummary.total++
                if (task.status === "completed") taskSummary.completed++
                else if (task.status === "in_progress") taskSummary.inProgress++
                else taskSummary.pending++
              } catch { /* skip bad task files */ }
            }
          } catch { /* no tasks dir */ }

          const leadMember = config.members?.find((m) => m.agentType === "team-lead")

          const team = await lead.annotate({
            name: config.name || teamName,
            description: config.description || "",
            createdAt: config.createdAt || 0,
            memberCount: config.members?.length || 0,
            leadName: leadMember?.name || "unknown",
            taskSummary,
          })
          if (team) teams.push(team)
        } catch { /* skip teams with bad config */ }
      }

      teams.sort((a, b) => b.createdAt - a.createdAt)

      sendJson(res, 200, teams)
    } catch (err) {
      sendJson(res, 500, { error: String(err) })
    }
  })

  // GET /api/team-detail/:teamName - full team detail
  use("/api/team-detail/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)

    if (parts.length !== 1) return next()

    const teamName = decodeTeamPathSegment(parts[0])
    if (!teamName) return sendInvalidTeamName(res)
    const team = await authorizeTeam(req, res, teamName, (lead) => authorizeSession(req, res, lead, "view"))
    if (!team) return
    const { config } = team
    if (!config) {
      sendJson(res, 404, { error: "Team not found" })
      return
    }

    const tasks: unknown[] = []
    try {
      const taskDir = join(dirs.TASKS_DIR, teamName)
      const taskFiles = await readdir(taskDir)
      for (const tf of taskFiles.filter((f) => f.endsWith(".json"))) {
        try {
          const taskRaw = await readFile(join(taskDir, tf), "utf-8")
          const task = JSON.parse(taskRaw)
          if (task.status !== "deleted") tasks.push(task)
        } catch { /* skip */ }
      }
    } catch { /* no tasks */ }

    const inboxes: Record<string, unknown[]> = {}
    try {
      const inboxDir = join(dirs.TEAMS_DIR, teamName, "inboxes")
      const inboxFiles = await readdir(inboxDir)
      for (const inf of inboxFiles.filter((f) => f.endsWith(".json"))) {
        try {
          const inboxRaw = await readFile(join(inboxDir, inf), "utf-8")
          const messages = JSON.parse(inboxRaw)
          const memberName = inf.replace(".json", "")
          inboxes[memberName] = Array.isArray(messages) ? messages : []
        } catch { /* skip */ }
      }
    } catch { /* no inboxes */ }

    sendJson(res, 200, { config, tasks, inboxes })
  })

  // GET /api/team-watch/:teamName - SSE for live team updates
  use("/api/team-watch/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)

    if (parts.length !== 1) return next()

    const teamName = decodeTeamPathSegment(parts[0])
    if (!teamName) return sendInvalidTeamName(res)
    if (!(await authorizeTeamAccess(req, res, teamName, (lead) => authorizeStreamSession(req, res, lead)))) return
    // The caller may have gone, or lost its login, while access was checked.
    if (res.destroyed || res.writableEnded) return

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    })
    res.write(`data: ${JSON.stringify({ type: "init" })}\n\n`)

    const unsubscribe = subscribeToTeam(teamName, () => {
      res.write(`data: ${JSON.stringify({ type: "update" })}\n\n`)
    })
    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n")
    }, 15000)

    req.on("close", () => {
      unsubscribe()
      clearInterval(heartbeat)
    })
  })

  // POST /api/team-message/:teamName/:memberName - send message to a team member's inbox
  use("/api/team-message/", (req, res, next) => {
    if (req.method !== "POST") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)

    if (parts.length !== 2) return next()

    const teamName = decodeTeamPathSegment(parts[0])
    const memberName = decodeTeamPathSegment(parts[1])
    if (!teamName || !memberName) return sendInvalidTeamName(res)
    const inboxPath = join(dirs.TEAMS_DIR, teamName, "inboxes", `${memberName}.json`)

    withJsonBody<{ message?: string }>(req, res, async ({ message }) => {
      const receivedAt = Date.now()
      if (!message || typeof message !== "string") {
        sendJson(res, 400, { error: "message is required" })
        return
      }
      const team = await authorizeTeamAccess(req, res, teamName, (lead) => authorizeSession(req, res, lead, "interact"))
      if (!team) return
      const session = team.lead && { sessionId: team.lead.sessionId, agent: TEAM_AGENT }
      const prompt = { receivedAt, route: "team-message" as const, session, recipient: memberName, input: message }

      try {
        await handPrompt(req, prompt, () => appendToInbox(inboxPath, message), "enqueued")
        sendJson(res, 200, { success: true })
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" })
      }
    })
  })
}
