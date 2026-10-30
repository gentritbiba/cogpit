import { useCallback, useEffect, useRef, useState } from "react"
import { authFetch } from "@/lib/auth"
import type { WorktreeSetupSnapshot } from "../../shared/contracts/worktreeSetup"

export function useWorktreeSetup(project: { cwd?: string | null; dirName?: string | null }, enabled = true) {
  const query = project.cwd ? `cwd=${encodeURIComponent(project.cwd)}` : project.dirName ? `dirName=${encodeURIComponent(project.dirName)}` : null
  const endpoint = enabled && query ? `/api/worktree-setup?${query}` : null
  const [state, setState] = useState<{ endpoint: string | null; snapshot: WorktreeSetupSnapshot | null; error: string | null }>({ endpoint, snapshot: null, error: null })
  const generation = useRef(0)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!endpoint) return
    const current = generation.current
    try {
      const response = await authFetch(endpoint, { signal })
      const value = await response.json()
      if (!response.ok) throw new Error(value.error || "Unable to load worktree setup")
      if (!signal?.aborted && current === generation.current) setState({ endpoint, snapshot: value, error: null })
    } catch (error) {
      if (!signal?.aborted && current === generation.current) setState((previous) => ({ endpoint, snapshot: previous.endpoint === endpoint ? previous.snapshot : null, error: error instanceof Error ? error.message : "Unable to load worktree setup" }))
    }
  }, [endpoint])
  useEffect(() => {
    generation.current++
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      await refresh(controller.signal)
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1000)
    }
    if (endpoint) void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [endpoint, refresh])

  const mutate = useCallback(async (method: "PUT" | "POST", body: unknown) => {
    if (!endpoint) throw new Error("Select a project first")
    const response = await authFetch(endpoint, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    const value = await response.json()
    if (!response.ok) throw new Error(value.error || "Worktree setup request failed")
    await refresh()
  }, [endpoint, refresh])
  return {
    snapshot: state.endpoint === endpoint ? state.snapshot : null,
    error: state.endpoint === endpoint ? state.error : null,
    configure: (command: string, trusted: boolean, timeoutMs: number) => mutate("PUT", { command, trusted, timeoutMs }),
    act: (operationId: string, action: "retry" | "cancel") => mutate("POST", { operationId, action }),
  }
}
