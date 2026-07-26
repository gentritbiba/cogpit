import { basename, dirname } from "node:path"
import { HttpBodyError, readJsonBody, sendJson, type UseFn } from "../http"
import { encodeCodexDirName } from "../sessionPaths"
import { deliverNotification } from "../lib/notificationDelivery"
import type { NotificationContent } from "../../shared/notifications"

const NOTIFICATION_COOLDOWN_MS = 5000
/** Drop cooldown entries for sessions that have gone quiet, bounding the map. */
const COOLDOWN_ENTRY_TTL_MS = 60_000
const BODY_MAX_CHARS = 120
/**
 * Codex sends the whole prompt (`input-messages`) plus the whole final message,
 * so the 64 KB default would reject exactly the long turns most worth
 * announcing.
 */
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024

const lastNotifiedAt = new Map<string, number>()

/**
 * Receives agent lifecycle payloads and raises a desktop notification.
 *
 * Two payload shapes are accepted, both forwarded verbatim by
 * ~/.agents/bin/cogpit-notify.sh:
 *  - Claude Code hooks (Stop / Notification): snake_case, on stdin
 *  - Codex `notify`: kebab-case agent-turn-complete, as the final argv element
 *
 * Whether a notification is actually shown is decided downstream: the Electron
 * main process drops it when the window already displays that session, and push
 * only goes out when nobody is at the desktop.
 *
 * Sessions Cogpit itself spawned are deliberately NOT filtered out here. They
 * used to be, on the assumption that the UI already showed them — but that meant
 * a user who runs everything inside Cogpit was never notified at all. Presence,
 * not provenance, decides now.
 */
export function registerNotifyRoutes(use: UseFn): void {
  use("/api/notify", async (req, res, next) => {
    if (req.method !== "POST") return next()

    let payload: Record<string, unknown>
    try {
      payload = await readJsonBody<Record<string, unknown>>(req, { maxBytes: MAX_PAYLOAD_BYTES })
    } catch (err) {
      // Distinguish too-large from malformed; both used to report "invalid JSON".
      if (err instanceof HttpBodyError) return sendJson(res, err.statusCode, { error: err.message })
      return sendJson(res, 400, { error: "Invalid JSON body" })
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return sendJson(res, 400, { error: "Invalid JSON body" })
    }

    // Agent tool spawns keep their transcripts under /subagents/; the parent
    // session reports for them.
    const transcriptPath = asString(payload.transcript_path)
    if (transcriptPath?.includes("/subagents/")) {
      return sendJson(res, 200, { success: true, skipped: "subagent" })
    }

    const event = isCodexNotify(payload) ? fromCodexNotify(payload) : fromClaudeHook(payload)

    if (isThrottled(event.nav.sessionId)) {
      return sendJson(res, 200, { success: true, throttled: true })
    }

    const title = asString(payload.title) ?? event.title
    // Truncated here rather than per-mapper so explicit overrides are cleaned too.
    const body = asString(payload.body) ?? asString(payload.message) ?? event.body

    deliverNotification({ title, body: truncate(body, BODY_MAX_CHARS), nav: event.nav })
    sendJson(res, 200, { success: true })
  })
}

/** Codex tags its payload and uses kebab-case keys; Claude hooks use neither. */
function isCodexNotify(payload: Record<string, unknown>): boolean {
  return payload.type === "agent-turn-complete" || typeof payload["thread-id"] === "string"
}

function fromCodexNotify(payload: Record<string, unknown>): NotificationContent {
  const cwd = asString(payload.cwd)
  const lastMessage = asString(payload["last-assistant-message"])
  return {
    title: cwd ? `Codex — ${basename(cwd)}` : "Codex",
    body: lastMessage ?? "Turn complete",
    nav: {
      sessionId: asString(payload["thread-id"]),
      dirName: cwd ? encodeCodexDirName(cwd) : null,
    },
  }
}

function fromClaudeHook(payload: Record<string, unknown>): NotificationContent {
  const cwd = asString(payload.cwd)
  const transcriptPath = asString(payload.transcript_path)
  const lastMessage = asString(payload.last_assistant_message)
  const hookEvent = asString(payload.hook_event_name) ?? asString(payload.event)

  let body: string
  if (lastMessage) body = lastMessage
  else if (hookEvent === "Stop") body = "Waiting for your input"
  else body = "Needs your attention"

  return {
    title: cwd ? `Claude Code — ${basename(cwd)}` : "Claude Code",
    body,
    nav: {
      sessionId: asString(payload.session_id),
      // Claude transcripts live at ~/.claude/projects/<dirName>/<sessionId>.jsonl
      dirName: transcriptPath ? basename(dirname(transcriptPath)) : null,
    },
  }
}

/** Per-session cooldown, so concurrent sessions never suppress each other. */
function isThrottled(sessionId: string | null): boolean {
  const now = Date.now()
  for (const [key, at] of lastNotifiedAt) {
    if (now - at > COOLDOWN_ENTRY_TTL_MS) lastNotifiedAt.delete(key)
  }

  const key = sessionId ?? "unknown"
  const previous = lastNotifiedAt.get(key)
  if (previous !== undefined && now - previous < NOTIFICATION_COOLDOWN_MS) return true

  lastNotifiedAt.set(key, now)
  return false
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function truncate(text: string, max: number): string {
  // Strip markdown punctuation so notification text reads as prose.
  const clean = text.replace(/[*_`#]/g, "").replace(/\n+/g, " ").trim()
  return clean.length <= max ? clean : clean.slice(0, max - 1) + "…"
}
