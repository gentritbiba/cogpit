import { useCallback, useEffect, useRef, useState } from "react"
import { authFetch } from "@/lib/auth"
import { withBase } from "@/lib/device"
import type { BrowserSkillStatus, BrowserSkillTarget, BrowserStatus } from "../../shared/browser/types"
import type { AgentKind } from "../../shared/session/agent-descriptors"

/**
 * The managed browsers behind the panel's session bar: `GET /api/browser` on a
 * poll, plus the mutations the bar offers. The live page comes from the
 * `/__browser` socket instead — this hook only owns the list.
 *
 * A mutation reports its own failure through the returned result, not through
 * `error`, so the create dialog can show a name conflict inline while `error`
 * stays reserved for a status refresh nobody asked for.
 */

const BROWSER_API = "/api/browser"
const POLL_INTERVAL = 5_000

export type BrowserActionResult = { ok: true } | { ok: false; error: string }
export type SkillInstallResult = { ok: true; paths: string[] } | { ok: false; error: string }
export type SkillTargetsResult =
  | { ok: true; targets: BrowserSkillTarget[] }
  | { ok: false; error: string }

/** Install for every CLI the user has, rather than naming one. */
export const ALL_SKILL_TARGETS = "all"
export type SkillTarget = AgentKind | typeof ALL_SKILL_TARGETS

export interface UseBrowserSessions {
  status: BrowserStatus | null
  loading: boolean
  /** Last status-refresh failure, cleared by the next successful poll. */
  error: string | null
  refresh: () => Promise<void>
  create: (name: string, note?: string) => Promise<BrowserActionResult>
  remove: (name: string) => Promise<BrowserActionResult>
  launch: (name: string, url?: string) => Promise<BrowserActionResult>
  stop: (name: string) => Promise<BrowserActionResult>
  setNote: (name: string, note: string) => Promise<BrowserActionResult>
  /** Where the browser skill can be installed, and where it already is. */
  readSkillTargets: () => Promise<SkillTargetsResult>
  installSkill: (target: SkillTarget) => Promise<SkillInstallResult>
}

function sessionPath(name: string, suffix = ""): string {
  return `${BROWSER_API}/sessions/${encodeURIComponent(name)}${suffix}`
}

function jsonBody(body: Record<string, unknown>): RequestInit {
  return { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const data = (await res.json()) as unknown
    return data && typeof data === "object" ? (data as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The route's `{ error }` message, or a caller-supplied fallback. */
async function readError(res: Response, fallback: string): Promise<string> {
  const data = await readJson(res)
  return typeof data?.error === "string" && data.error ? data.error : fallback
}

export function useBrowserSessions(enabled: boolean): UseBrowserSessions {
  const [status, setStatus] = useState<BrowserStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(false)
  const requestSequence = useRef(0)
  const inFlight = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current
    inFlight.current = true
    setLoading(true)
    try {
      const res = await authFetch(withBase(BROWSER_API))
      const next = res.ok ? (await res.json()) as BrowserStatus : null
      if (!mounted.current || sequence !== requestSequence.current) return
      if (next) {
        // The panel re-renders on every status change, so keep the previous
        // object whenever a poll brings back the same list.
        setStatus((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next)
        setError(null)
      } else {
        setError(await readError(res, `Could not read the browser list (${res.status})`))
      }
    } catch (cause) {
      if (mounted.current && sequence === requestSequence.current) {
        setError(messageOf(cause, "Could not read the browser list"))
      }
    } finally {
      if (sequence === requestSequence.current) {
        inFlight.current = false
        if (mounted.current) setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    void refresh()
    // A poll skips its turn rather than stacking on a request that is still
    // out; a mutation's own refresh is never skipped, so a new browser shows up
    // as soon as it exists rather than on the next tick.
    const timer = setInterval(() => {
      if (!inFlight.current) void refresh()
    }, POLL_INTERVAL)
    return () => clearInterval(timer)
  }, [enabled, refresh])

  const mutate = useCallback(async (
    path: string,
    init: RequestInit,
    fallback: string,
  ): Promise<{ ok: true; data: Record<string, unknown> | null } | { ok: false; error: string }> => {
    let res: Response
    try {
      res = await authFetch(withBase(path), init)
    } catch (cause) {
      return { ok: false, error: messageOf(cause, fallback) }
    }
    if (!res.ok) return { ok: false, error: await readError(res, fallback) }
    // A 204 has no body; readJson answers null for it.
    const data = await readJson(res)
    void refresh()
    return { ok: true, data }
  }, [refresh])

  const perform = useCallback(async (
    path: string,
    init: RequestInit,
    fallback: string,
  ): Promise<BrowserActionResult> => {
    const result = await mutate(path, init, fallback)
    return result.ok ? { ok: true } : result
  }, [mutate])

  const create = useCallback((name: string, note?: string) => perform(
    `${BROWSER_API}/sessions`,
    { method: "POST", ...jsonBody({ name, note }) },
    `Could not create ${name}`,
  ), [perform])

  const remove = useCallback((name: string) => perform(
    sessionPath(name),
    { method: "DELETE" },
    `Could not delete ${name}`,
  ), [perform])

  const launch = useCallback((name: string, url?: string) => perform(
    sessionPath(name, "/launch"),
    { method: "POST", ...jsonBody(url ? { url } : {}) },
    `Could not open ${name}`,
  ), [perform])

  const stop = useCallback((name: string) => perform(
    sessionPath(name, "/stop"),
    { method: "POST" },
    `Could not stop ${name}`,
  ), [perform])

  const setNote = useCallback((name: string, note: string) => perform(
    sessionPath(name),
    { method: "PATCH", ...jsonBody({ note }) },
    `Could not save the note for ${name}`,
  ), [perform])

  const readSkillTargets = useCallback(async (): Promise<SkillTargetsResult> => {
    const fallback = "Could not read where the browser skill is installed"
    let res: Response
    try {
      res = await authFetch(withBase(`${BROWSER_API}/skill`))
    } catch (cause) {
      return { ok: false, error: messageOf(cause, fallback) }
    }
    if (!res.ok) return { ok: false, error: await readError(res, fallback) }
    const data = (await readJson(res)) as BrowserSkillStatus | null
    return Array.isArray(data?.targets)
      ? { ok: true, targets: data.targets }
      : { ok: false, error: fallback }
  }, [])

  const installSkill = useCallback(async (target: SkillTarget): Promise<SkillInstallResult> => {
    const fallback = "Could not install the browser skill"
    const result = await mutate(
      `${BROWSER_API}/skill/install`,
      { method: "POST", ...jsonBody({ target }) },
      fallback,
    )
    if (!result.ok) return result
    const { paths } = result.data ?? {}
    return Array.isArray(paths) && paths.every((path) => typeof path === "string")
      ? { ok: true, paths }
      : { ok: false, error: fallback }
  }, [mutate])

  return {
    status,
    loading,
    error,
    refresh,
    create,
    remove,
    launch,
    stop,
    setNote,
    readSkillTargets,
    installSkill,
  }
}
