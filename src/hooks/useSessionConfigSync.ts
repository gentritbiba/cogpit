import { useEffect, useRef } from "react"
import {
  fetchSessionConfig,
  saveSessionConfig,
  type SessionConfig,
} from "@/lib/sessionConfig"

/** Fields this hook owns. MCP selection is synced separately by useMcpServers. */
export interface ComposerConfigValues {
  model: string
  effort: string
  fastMode: boolean
  ultracode: boolean
  permissionMode: SessionConfig["permissionMode"]
}

const COMPOSER_FIELDS: ReadonlyArray<keyof ComposerConfigValues> = [
  "model",
  "effort",
  "fastMode",
  "ultracode",
  "permissionMode",
]

interface UseSessionConfigSyncOptions {
  /** Session fileName, or null while composing a new session (nothing to sync yet). */
  sessionKey: string | null
  values: ComposerConfigValues
  /** Applies stored config to UI state. Called once per session open. */
  onHydrate: (config: SessionConfig) => void
}

/**
 * Keeps the composer/session-controls state (model, reasoning, speed,
 * ultracode, access mode) session-specific and shared across Cogpit clients:
 * hydrates from the server-side session config when a session opens, and
 * persists every change back. A session that has no stored config yet is
 * seeded with the current values (e.g. right after creation).
 */
export function useSessionConfigSync({
  sessionKey,
  values,
  onHydrate,
}: UseSessionConfigSyncOptions) {
  const hydratedKeyRef = useRef<string | null>(null)
  // Last snapshot known to match the server — suppresses the echo save that
  // would otherwise follow hydration.
  const lastSyncedRef = useRef<string | null>(null)
  const onHydrateRef = useRef(onHydrate)
  onHydrateRef.current = onHydrate
  const valuesRef = useRef(values)
  valuesRef.current = values

  useEffect(() => {
    hydratedKeyRef.current = null
    lastSyncedRef.current = null
    if (!sessionKey) return
    let cancelled = false
    void fetchSessionConfig(sessionKey).then((config) => {
      if (cancelled) return
      // null means the fetch FAILED (offline, server restart) — not "nothing
      // stored" (that is a 200 with `{}`). Bail without seeding or enabling
      // persistence: seeding here would PUT this client's local values over
      // the session's real stored config once the server recovers.
      if (config === null) return
      const stored = COMPOSER_FIELDS.some((field) => config[field] !== undefined)
      if (stored) {
        onHydrateRef.current(config)
        const current = valuesRef.current
        const hydrated: ComposerConfigValues = {
          model: config.model ?? current.model,
          effort: config.effort ?? current.effort,
          fastMode: config.fastMode ?? current.fastMode,
          ultracode: config.ultracode ?? current.ultracode,
          permissionMode: config.permissionMode ?? current.permissionMode,
        }
        lastSyncedRef.current = JSON.stringify(hydrated)
      } else {
        // Nothing stored yet — seed the session with the current values.
        saveSessionConfig(sessionKey, valuesRef.current)
        lastSyncedRef.current = JSON.stringify(valuesRef.current)
      }
      hydratedKeyRef.current = sessionKey
    })
    return () => {
      cancelled = true
    }
  }, [sessionKey])

  const serialized = JSON.stringify(values)
  useEffect(() => {
    if (!sessionKey || hydratedKeyRef.current !== sessionKey) return
    if (serialized === lastSyncedRef.current) return
    lastSyncedRef.current = serialized
    saveSessionConfig(sessionKey, valuesRef.current)
  }, [serialized, sessionKey])
}
