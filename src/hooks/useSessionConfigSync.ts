import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  fetchSessionConfig,
  flushSessionConfig,
  saveSessionConfig,
  type SessionConfig,
} from "@/lib/sessionConfig"
import { onSessionConfigChanged } from "@/lib/sessionConfigEvents"
import { permissionsForAccess, type SessionAccessState } from "@/lib/sessionAccessPermissions"
import {
  isSessionSettingField,
  SESSION_SETTING_FIELDS,
  type SessionSettingField,
} from "../../shared/contracts/sessionSettings"

/** Fields this hook owns. MCP selection is synced separately by useMcpServers. */
export interface ComposerConfigValues {
  model: string
  effort: string
  contextWindowTokens: number | null
  fastMode: boolean
  ultracode: boolean
  permissionMode: SessionConfig["permissionMode"]
}

function serializeConfig(values: ComposerConfigValues): string {
  return JSON.stringify(values, [...SESSION_SETTING_FIELDS])
}

function changedFields(from: ComposerConfigValues, to: ComposerConfigValues): SessionSettingField[] {
  return SESSION_SETTING_FIELDS.filter((field) => from[field] !== to[field])
}

function fieldsOf(values: ComposerConfigValues, fields: readonly SessionSettingField[]): Partial<ComposerConfigValues> {
  const patch: Partial<ComposerConfigValues> = {}
  for (const field of fields) Object.assign(patch, { [field]: values[field] })
  return patch
}

/** What a stored config sets the composer to; `known` fills what it leaves out. */
function storedValues(config: SessionConfig, known: ComposerConfigValues): ComposerConfigValues {
  return {
    model: config.model ?? known.model,
    effort: config.effort ?? known.effort,
    contextWindowTokens: config.contextWindowTokens ?? null,
    fastMode: config.fastMode ?? known.fastMode,
    ultracode: config.ultracode ?? known.ultracode,
    permissionMode: config.permissionMode ?? known.permissionMode,
  }
}

interface KeyedValues {
  key: string
  values: ComposerConfigValues
}

interface UseSessionConfigSyncOptions {
  /** Session fileName, or null while composing a new session (nothing to sync yet). */
  sessionKey: string | null
  /** The session's id, which its stream names when the stored config changes. */
  sessionId: string | null
  values: ComposerConfigValues
  /** The caller's access to the session. It writes from interact up; every change reads the config again. */
  access: SessionAccessState
  /** Applies stored config to UI state. */
  onHydrate: (config: SessionConfig) => void
}

export interface SessionConfigSync {
  /**
   * The fields the user changed in this client that the server is not known
   * to hold: not in the last read, and not in a save of this client it stored
   * since. A send names these as its `settingsChange`.
   */
  picked: readonly SessionSettingField[]
  /** Call once a send or live apply carrying the picks went through: this client's waiting saves of the session go out now, each clearing the picks it stored. */
  settlePicked: () => void
}

/**
 * Keeps the composer/session-controls state (model, reasoning, speed,
 * ultracode, access mode) session-specific and shared across Cogpit clients.
 * The session's server-side config is read when it opens, again whenever the
 * caller's access to it changes, its stream says the config changed, or the
 * window comes back after being hidden. Each read after the first keeps what
 * the user changed that the server has not been sent yet. While the user may
 * write, each change they make is saved back, field by field. A session with
 * nothing stored yet is seeded with the current values once it is writable;
 * the permission mode only by its owner.
 */
export function useSessionConfigSync({
  sessionKey,
  sessionId,
  values,
  access,
  onHydrate,
}: UseSessionConfigSyncOptions): SessionConfigSync {
  // What the server holds as far as it has answered: the last read, and each
  // save of this client it stored since. A value that differs from it now is
  // one the user picked.
  const [confirmed, setConfirmed] = useState<KeyedValues | null>(null)
  // What the server holds once this client's saves land: the last read and
  // every save made since. Null until the open session's config is first read.
  const savedRef = useRef<KeyedValues | null>(null)
  // Counts reads; only the latest one's answer is used.
  const readsRef = useRef(0)
  const onHydrateRef = useRef(onHydrate)
  onHydrateRef.current = onHydrate
  const valuesRef = useRef(values)
  valuesRef.current = values
  const accessRef = useRef(access)
  accessRef.current = access

  const save = useCallback((key: string, next: ComposerConfigValues) => {
    const saved = savedRef.current
    if (saved?.key !== key || !permissionsForAccess(accessRef.current).configure) return
    const fields = changedFields(saved.values, next)
    if (fields.length === 0) return
    const patch = fieldsOf(next, fields)
    savedRef.current = { key, values: next }
    void saveSessionConfig(key, patch).then((stored) => {
      if (!stored) return
      setConfirmed((held) => held?.key === key ? { key, values: { ...held.values, ...patch } } : held)
    })
  }, [])

  const read = useCallback((key: string) => {
    const reading = ++readsRef.current
    const asked = valuesRef.current
    const saved = savedRef.current?.key === key ? savedRef.current.values : null
    void fetchSessionConfig(key).then((config) => {
      // null means the read FAILED (offline, server restart) — not "nothing
      // stored" (that is a 200 with `{}`). Seeding here would PUT this
      // client's local values over the session's real stored config once the
      // server recovers.
      if (reading !== readsRef.current || config === null) return
      const current = valuesRef.current
      const writable = permissionsForAccess(accessRef.current).configure
      if (!SESSION_SETTING_FIELDS.some((field) => config[field] !== undefined)) {
        savedRef.current = { key, values: current }
        setConfirmed({ key, values: current })
        if (!writable) return
        const seeded = accessRef.current === "own"
          ? SESSION_SETTING_FIELDS
          : SESSION_SETTING_FIELDS.filter((field) => field !== "permissionMode")
        saveSessionConfig(key, fieldsOf(current, seeded))
        return
      }
      const stored = storedValues(config, saved ?? current)
      // The first read applies the stored config whole; a later one keeps
      // what the server was never sent and what changed while it was out.
      const kept = saved
        ? [...new Set([...changedFields(saved, asked), ...changedFields(asked, current)])]
        : []
      const next = { ...stored, ...fieldsOf(current, kept) }
      if (!saved || changedFields(current, next).length > 0) {
        onHydrateRef.current({ ...config, ...fieldsOf(current, kept) })
      }
      savedRef.current = { key, values: stored }
      setConfirmed({ key, values: stored })
      save(key, next)
    })
  }, [save])

  useEffect(() => {
    if (savedRef.current?.key !== sessionKey) savedRef.current = null
    if (!sessionKey) return
    read(sessionKey)
    return () => {
      readsRef.current += 1
    }
  }, [sessionKey, access, read])

  useEffect(() => {
    if (!sessionKey) return
    const reread = () => read(sessionKey)
    const stopChanges = sessionId ? onSessionConfigChanged(sessionId, reread) : undefined
    let hidden = document.visibilityState === "hidden"
    function onReturn(): void {
      if (!hidden) return
      hidden = false
      reread()
    }
    function onVisibilityChange(): void {
      if (document.visibilityState === "hidden") hidden = true
      else onReturn()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    window.addEventListener("focus", onReturn)
    return () => {
      stopChanges?.()
      document.removeEventListener("visibilitychange", onVisibilityChange)
      window.removeEventListener("focus", onReturn)
    }
  }, [sessionKey, sessionId, read])

  const serialized = serializeConfig(values)
  useEffect(() => {
    if (sessionKey) save(sessionKey, valuesRef.current)
  }, [serialized, sessionKey, save])

  // Keyed by the field names, so the list stays the same object while they do.
  const pickedNames = confirmed?.key === sessionKey ? changedFields(confirmed.values, values).join() : ""
  const picked = useMemo(() => pickedNames.split(",").filter(isSessionSettingField), [pickedNames])
  const settlePicked = useCallback(() => {
    if (sessionKey) void flushSessionConfig(sessionKey)
  }, [sessionKey])
  return { picked, settlePicked }
}
