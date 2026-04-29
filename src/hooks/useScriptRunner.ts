import { useMemo, useCallback } from "react"
import { usePty } from "@/contexts/PtyContext"
import type { ProcessEntry } from "@/hooks/useProcessPanel"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ManagedProcess {
  id: string
  name: string
  cwd: string
  status: "running" | "stopped" | "errored"
  source: string
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useScriptRunner(
  onProcessStarted?: (entry: ProcessEntry) => void,
) {
  const pty = usePty()

  const runningProcesses = useMemo(() => {
    const map = new Map<string, ManagedProcess>()
    for (const session of pty.sessions) {
      if (session.metadata?.type !== "script") continue
      map.set(session.id, {
        id: session.id,
        name: session.name,
        cwd: session.cwd,
        status: session.status === "running" ? "running" : "stopped",
        source: session.metadata.source ?? "root/",
      })
    }
    return map
  }, [pty.sessions])

  const runScript = useCallback((
    scriptName: string,
    packageDir: string,
    source: string,
  ): void => {
    const id = pty.spawnScript({
      name: scriptName,
      cwd: packageDir,
      source,
      scriptName,
    })

    const label = source === "root/" ? scriptName : `${source.replace(/\/$/, "")}:${scriptName}`
    onProcessStarted?.({
      id,
      name: label,
      type: "script",
      status: "running",
      source,
    })
  }, [pty, onProcessStarted])

  const stopScript = useCallback((processId: string): void => {
    pty.killSession(processId)
  }, [pty])

  return { runningProcesses, runScript, stopScript }
}
