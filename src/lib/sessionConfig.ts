import { authFetch, jsonFetch } from "@/lib/auth"
import type { PermissionMode } from "@/lib/permissions"
import { deviceScopedKey } from "@/lib/device"

/**
 * Per-session UI configuration persisted on the Cogpit server so every client
 * (any browser or device, including hub-proxied remotes) sees the same session
 * controls state. Keyed by session fileName, with the project dirName used as
 * a project-level fallback for MCP selection on new sessions.
 */
export interface SessionConfig {
  model?: string
  effort?: string
  contextWindowTokens?: number | null
  fastMode?: boolean
  ultracode?: boolean
  permissionMode?: PermissionMode
  mcpServers?: string[]
}

/**
 * Use the provider-neutral session ID for persisted controls. Claude's
 * historical key was already `<session-id>.jsonl`; this preserves that layout
 * while avoiding nested Codex rollout paths that are invalid storage keys.
 */
export function getSessionConfigKey(
  sessionId: string | null | undefined,
  fileName: string | null | undefined,
): string | null {
  return sessionId ? `${sessionId}.jsonl` : fileName ?? null
}

/**
 * The session's stored config, or null when the read failed. This client's own
 * saves of the session land first, so the answer already reflects them.
 */
export async function fetchSessionConfig(key: string): Promise<SessionConfig | null> {
  await flushSessionConfig(key)
  try {
    const res = await authFetch(`/api/session-config/${encodeURIComponent(key)}`)
    if (!res.ok) return null
    const data = await res.json()
    return data && typeof data === "object" ? data as SessionConfig : null
  } catch {
    return null
  }
}

const SAVE_DEBOUNCE_MS = 300

interface PendingSave {
  patch: SessionConfig
  timer: ReturnType<typeof setTimeout>
  /** Whether the server stored the patch, for every save merged into it. */
  stored: Promise<boolean>
  answer: (stored: boolean) => void
}

const pendingSaves = new Map<string, PendingSave>()
/** Each key's latest save on the wire; saves of one key go out one after another. */
const sending = new Map<string, Promise<boolean>>()

function send(pendingKey: string, key: string, patch: SessionConfig): Promise<boolean> {
  const sent = (sending.get(pendingKey) ?? Promise.resolve(true)).then(async () => {
    try {
      const res = await jsonFetch(`/api/session-config/${encodeURIComponent(key)}`, patch, { method: "PUT" })
      return res.ok
    } catch {
      // Offline or server restart — the next change retries.
      return false
    }
  })
  sending.set(pendingKey, sent)
  void sent.then(() => {
    if (sending.get(pendingKey) === sent) sending.delete(pendingKey)
  })
  return sent
}

function unansweredSave(): Pick<PendingSave, "stored" | "answer"> {
  let answer!: (stored: boolean) => void
  const stored = new Promise<boolean>((resolve) => { answer = resolve })
  return { stored, answer }
}

function sendPending(pendingKey: string, key: string, pending: PendingSave): Promise<boolean> {
  clearTimeout(pending.timer)
  pendingSaves.delete(pendingKey)
  const sent = send(pendingKey, key, pending.patch)
  void sent.then(pending.answer)
  return sent
}

/** Send the key's save still waiting out its debounce now; resolves once every save of the key is answered. */
export async function flushSessionConfig(key: string): Promise<void> {
  const pendingKey = deviceScopedKey(key)
  const pending = pendingSaves.get(pendingKey)
  await (pending ? sendPending(pendingKey, key, pending) : sending.get(pendingKey))
}

/**
 * Debounced partial save, resolving to whether the server stored it. The
 * server merges the patch into the stored config, so independent writers
 * (composer settings, MCP selection) never clobber each other's fields.
 */
export function saveSessionConfig(key: string, patch: SessionConfig): Promise<boolean> {
  const pendingKey = deviceScopedKey(key)
  const pending = pendingSaves.get(pendingKey)
  if (pending) clearTimeout(pending.timer)
  const { stored, answer } = pending ?? unansweredSave()
  const next: PendingSave = {
    patch: pending ? { ...pending.patch, ...patch } : patch,
    stored,
    answer,
    timer: setTimeout(() => {
      if (deviceScopedKey(key) === pendingKey) {
        void sendPending(pendingKey, key, next)
      } else {
        pendingSaves.delete(pendingKey)
        next.answer(false)
      }
    }, SAVE_DEBOUNCE_MS),
  }
  pendingSaves.set(pendingKey, next)
  return stored
}
