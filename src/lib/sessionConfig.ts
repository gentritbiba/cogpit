import { authFetch } from "@/lib/auth"
import type { PermissionMode } from "@/lib/permissions"

/**
 * Per-session UI configuration persisted on the Cogpit server so every client
 * (any browser or device, including hub-proxied remotes) sees the same session
 * controls state. Keyed by session fileName, with the project dirName used as
 * a project-level fallback for MCP selection on new sessions.
 */
export interface SessionConfig {
  model?: string
  effort?: string
  fastMode?: boolean
  ultracode?: boolean
  permissionMode?: PermissionMode
  mcpServers?: string[]
}

export async function fetchSessionConfig(key: string): Promise<SessionConfig | null> {
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
const pendingSaves = new Map<string, { patch: SessionConfig; timer: ReturnType<typeof setTimeout> }>()

/**
 * Debounced fire-and-forget partial save. The server merges the patch into the
 * stored config, so independent writers (composer settings, MCP selection)
 * never clobber each other's fields.
 */
export function saveSessionConfig(key: string, patch: SessionConfig): void {
  const pending = pendingSaves.get(key)
  const merged = pending ? { ...pending.patch, ...patch } : patch
  if (pending) clearTimeout(pending.timer)

  const timer = setTimeout(() => {
    pendingSaves.delete(key)
    void (async () => {
      try {
        await authFetch(`/api/session-config/${encodeURIComponent(key)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(merged),
        })
      } catch {
        // Offline or server restart — the next change retries.
      }
    })()
  }, SAVE_DEBOUNCE_MS)
  pendingSaves.set(key, { patch: merged, timer })
}
