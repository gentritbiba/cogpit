/**
 * ntfy delivery. Published as a JSON body rather than X-Title/X-Message headers
 * because HTTP headers cannot carry UTF-8 reliably — emoji and CJK in an
 * assistant message would arrive mangled or break the request outright.
 */
import { sessionPath, type NotificationContent } from "../../shared/notifications"
import { getPushConfig, type PushConfig } from "./pushConfig"

/** ntfy turns anything past 4096 bytes into an attachment; stay well clear. */
const MESSAGE_MAX_BYTES = 1024
const TITLE_MAX_BYTES = 256
const REQUEST_TIMEOUT_MS = 5000

const encoder = new TextEncoder()

interface NtfyPayload {
  topic: string
  title: string
  message: string
  tags: string[]
  click?: string
}

/** Truncate on code-point boundaries so a split emoji never corrupts the JSON. */
function truncateBytes(text: string, maxBytes: number): string {
  if (encoder.encode(text).length <= maxBytes) return text

  const budget = maxBytes - 3 // "…" is 3 bytes in UTF-8
  let out = ""
  let used = 0
  for (const char of text) {
    const size = encoder.encode(char).length
    if (used + size > budget) break
    out += char
    used += size
  }
  return `${out}…`
}

/** Strip C0/C1 controls; they survive JSON but render as garbage on the phone. */
function stripControls(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim()
}

export function buildNtfyPayload(notification: NotificationContent, config: PushConfig): NtfyPayload {
  const title = truncateBytes(stripControls(notification.title), TITLE_MAX_BYTES) || "Cogpit"
  const message =
    truncateBytes(stripControls(notification.body), MESSAGE_MAX_BYTES) || "Needs your attention"

  const payload: NtfyPayload = { topic: config.topic, title, message, tags: ["robot"] }

  // Without a reachable base URL a click target would point at 127.0.0.1 and
  // dead-end on the phone, so omit the action entirely.
  const path = sessionPath(notification.nav)
  if (config.publicUrl && path) payload.click = `${config.publicUrl}${path}`

  return payload
}

/**
 * Publish to ntfy. Never throws and never rejects: a notification is best
 * effort and must not fail the agent turn that triggered it.
 */
export async function sendPushNotification(
  notification: NotificationContent,
  config = getPushConfig(),
): Promise<boolean> {
  if (!config) return false

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (config.token) headers.Authorization = `Bearer ${config.token}`

  try {
    const response = await fetch(config.ntfyUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(buildNtfyPayload(notification, config)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    })
    if (!response.ok) {
      console.error(`[push] ntfy rejected the message: HTTP ${response.status}`)
      return false
    }
    return true
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`[push] Could not reach ${config.ntfyUrl}: ${reason}`)
    return false
  }
}
