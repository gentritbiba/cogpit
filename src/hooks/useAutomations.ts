import { useCallback, useEffect, useState } from "react"
import { authFetch, jsonFetch } from "@/lib/auth"
import type { AutomationDefinition, AutomationRun, AutomationTask, SaveAutomationResponse } from "../../shared/contracts/automations"

async function read<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`)
  return body
}

export type RunAction = "cancel" | "reauthorize" | "mark-started" | "mark-not-started"

/** The caller's scheduled and webhook tasks, refreshed while the panel is open. */
export function useAutomations(active: boolean) {
  const [tasks, setTasks] = useState<AutomationTask[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setTasks((await read<{ tasks: AutomationTask[] }>(await authFetch("/api/automations"))).tasks)
      setError(null)
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not load tasks") }
  }, [])

  useEffect(() => {
    if (!active) return
    void refresh()
    const timer = setInterval(() => { void refresh() }, 10_000)
    return () => clearInterval(timer)
  }, [active, refresh])

  const run = useCallback(async <T,>(request: () => Promise<Response>): Promise<T> => {
    const result = await read<T>(await request())
    void refresh()
    return result
  }, [refresh])

  return {
    tasks,
    error,
    refresh,
    save: (definition: AutomationDefinition, state: "active" | "paused", existing?: AutomationTask) => run<SaveAutomationResponse>(() => existing
      ? jsonFetch(`/api/automations/${existing.id}`, { definition, state, expectedRevision: existing.revision }, { method: "PUT" })
      : jsonFetch("/api/automations", { definition, state })),
    remove: (id: string) => run(() => authFetch(`/api/automations/${id}`, { method: "DELETE" })),
    act: (id: string, verb: "pause" | "resume" | "run") => run(() => jsonFetch(`/api/automations/${id}/${verb}`, {})),
    rotate: (id: string) => run<{ webhookSecret: string }>(() => jsonFetch(`/api/automations/${id}/rotate-secret`, {})),
    runs: async (id: string) => (await read<{ runs: AutomationRun[] }>(await authFetch(`/api/automations/${id}/runs`))).runs,
    actOnRun: (id: string, runId: string, action: RunAction) => run(() => jsonFetch(`/api/automations/${id}/runs/${runId}/${action}`, {})),
  }
}
