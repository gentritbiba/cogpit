import { sendJson, type UseFn } from "../http"
import { persistentSessions } from "../helpers"
import { basename, dirname } from "node:path"
import { showNotification } from "../lib/desktopNotify"

let lastNotificationTime = 0
const NOTIFICATION_COOLDOWN_MS = 5000

export function registerNotifyRoutes(use: UseFn): void {
  use("/api/notify", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => {
      body += chunk
    })
    req.on("end", () => {
      try {
        const data = JSON.parse(body)

        const sessionId: string | null = data.session_id || null
        const transcriptPath: string | null = data.transcript_path || null

        // Skip subagents (Agent tool spawns) — their transcripts live in /subagents/
        if (transcriptPath && transcriptPath.includes("/subagents/")) {
          return sendJson(res, 200, { success: true, skipped: "subagent" })
        }

        // Skip Cogpit-managed sessions (spawned via /api/create-and-send)
        if (sessionId && persistentSessions.has(sessionId)) {
          return sendJson(res, 200, { success: true, skipped: "cogpit-session" })
        }

        // Throttle: check cooldown before doing any work
        const now = Date.now()
        if (now - lastNotificationTime < NOTIFICATION_COOLDOWN_MS) {
          return sendJson(res, 200, { success: true, throttled: true })
        }
        lastNotificationTime = now

        const cwd: string | null = data.cwd || null
        const hookEvent: string | null = data.hook_event_name || data.event || null

        const projectName = cwd ? basename(cwd) : null
        const dirName = transcriptPath ? basename(dirname(transcriptPath)) : null

        const title = data.title || (projectName ? `Claude Code — ${projectName}` : "Claude Code")

        // Use last_assistant_message snippet for richer notification body
        const lastMsg: string | null = data.last_assistant_message || null
        const message =
          data.body ||
          data.message ||
          (lastMsg ? truncate(lastMsg, 120) : (hookEvent === "Stop" ? "Waiting for your input" : "Needs your attention"))

        showNotification(title, message, { sessionId, dirName })
        sendJson(res, 200, { success: true })
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" })
      }
    })
  })
}

function truncate(text: string, max: number): string {
  // Strip markdown-style formatting for cleaner notification text
  const clean = text.replace(/[*_`#]/g, "").replace(/\n+/g, " ").trim()
  return clean.length <= max ? clean : clean.slice(0, max - 1) + "…"
}
