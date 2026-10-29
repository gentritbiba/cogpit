import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { RateLimitBanner } from "@/components/RateLimitBanner"
import { authFetch } from "@/lib/auth"
import type { RateLimitBlock } from "../../shared/session/rateLimit"
import { isTerminalOccurrence } from "../../shared/contracts/triggers"
import type { RecoveryStatus } from "../../shared/contracts/recovery"

interface Props {
  className?: string
  sessionId: string
  block: RateLimitBlock | null
  dirName: string
  fileName: string
  cwd: string | null
  terminal: boolean
  canResume: boolean
}

function runText(run: NonNullable<RecoveryStatus["run"]>): string {
  if (run.state === "unknown" || run.command?.state === "unknown") return "Delivery is uncertain. Inspect native history, then resolve this message in the session queue. It will not be resent automatically."
  if (run.state === "held" || run.command?.state === "held") return run.reason ?? run.command?.error ?? "Recovery is held. Review the session and reauthorize to continue."
  if (run.state === "scheduled") return `Resume is scheduled for ${new Date(run.dueAt).toLocaleString()}.`
  if (run.state === "admitting") return "Preparing the authorized continuation…"
  if (run.state === "admitted") return run.command && ["dispatching", "delivered"].includes(run.command.state) ? "Continuation has started. Use Stop to end the session." : "Continuation is in the session queue."
  if (run.state === "completed") return "The authorized continuation was delivered."
  return run.reason ?? `Recovery ${run.state}.`
}

/** Server state survives tab closure and restarts; no client timer dispatches work. */
export function AllowanceRecovery({ sessionId, block, canResume, className, ...banner }: Props) {
  const [snapshot, setSnapshot] = useState<{ sessionId: string; data: RecoveryStatus } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [scope, setScope] = useState(0)
  const generation = useRef(0)
  const mutationVersion = useRef(0)
  const mutation = useRef<AbortController | null>(null)
  const data = snapshot?.sessionId === sessionId ? snapshot.data : null

  useEffect(() => {
    const reset = () => { generation.current++; mutation.current?.abort(); mutation.current = null; setSnapshot(null); setError(null); setBusy(false); setScope((scope) => scope + 1) }
    window.addEventListener("cogpit-identity-changed", reset)
    window.addEventListener("cogpit-device-scope-changed", reset)
    return () => {
      window.removeEventListener("cogpit-identity-changed", reset)
      window.removeEventListener("cogpit-device-scope-changed", reset)
    }
  }, [])

  useEffect(() => {
    setBusy(false)
    const controller = new AbortController()
    const current = ++generation.current
    let timer: ReturnType<typeof setTimeout>
    let fetching = false
    let denied = false
    const refresh = async () => {
      if (fetching || controller.signal.aborted || denied) return
      if (mutation.current) { timer = setTimeout(() => { void refresh() }, 3000); return }
      fetching = true
      const version = mutationVersion.current
      clearTimeout(timer)
      try {
        const response = await authFetch(`/api/session-commands?recovery=1&sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal })
        if (!response.ok) {
          denied = [401, 403, 404].includes(response.status)
          throw new Error(`Recovery unavailable (${response.status})`)
        }
        const data = await response.json() as RecoveryStatus
        if (!controller.signal.aborted && current === generation.current && version === mutationVersion.current) { setSnapshot({ sessionId, data }); setError(null) }
      } catch (error) {
        if (!controller.signal.aborted && current === generation.current && version === mutationVersion.current) { if (denied) setSnapshot(null); setError(error instanceof Error ? error.message : "Recovery unavailable") }
      } finally {
        fetching = false
        if (!controller.signal.aborted && !denied) timer = setTimeout(() => { void refresh() }, 3000)
      }
    }
    const update = () => { void refresh() }
    void refresh()
    window.addEventListener("cogpit-command-accepted", update)
    window.addEventListener("online", update)
    return () => { controller.abort(); mutation.current?.abort(); mutation.current = null; clearTimeout(timer); window.removeEventListener("cogpit-command-accepted", update); window.removeEventListener("online", update) }
  }, [sessionId, block, scope])

  const action = async (action: "enable" | "cancel" | "reauthorize") => {
    if (mutation.current) return
    const controller = new AbortController()
    mutation.current = controller
    mutationVersion.current++
    const current = generation.current
    setBusy(true); setError(null)
    try {
      const response = await authFetch("/api/session-commands?recovery=1", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ sessionId, action, ...(action === "enable" ? { offerId: data?.offer?.id } : {}) }),
      })
      const result = await response.json() as RecoveryStatus & { error?: string }
      if (!response.ok) throw new Error(result.error ?? "Recovery update failed")
      if (!controller.signal.aborted && current === generation.current) setSnapshot({ sessionId, data: result })
    } catch (error) {
      if (!controller.signal.aborted && current === generation.current) setError(error instanceof Error ? error.message : "Recovery update failed")
    } finally {
      if (mutation.current === controller) mutation.current = null
      if (current === generation.current) setBusy(false)
    }
  }

  const run = data?.run
  const active = run && !isTerminalOccurrence(run.state)
  const visibleBlock = block ?? data?.offer?.block ?? (active ? run.block : null)
  if (!visibleBlock) return null
  const held = run?.state === "held" || run?.command?.state === "held"
  const cancellable = !run?.command || ["queued", "held"].includes(run.command.state)
  const unknown = run?.state === "unknown" || run?.command?.state === "unknown"
  return (
    <div className={className}>
      <RateLimitBanner block={visibleBlock} {...banner}>
        <div className="flex flex-col items-start gap-2" aria-label="Usage limit recovery" aria-busy={busy}>
          {data?.offer && canResume && !active && (
            <>
              <span>Send once after reset: “{data.message}” New work, pending input, archiving or changed access cancels recovery.</span>
              {data.support === "none" && <span>This server requires you to return and reauthorize after reset.</span>}
              <Button size="sm" variant="outline" disabled={busy} onClick={() => { void action("enable") }}>Resume when limit resets</Button>
            </>
          )}
          {run && <span>{runText(run)}</span>}
          {active && canResume && !unknown && cancellable && (
            <div className="flex flex-wrap gap-2">
              {held && <Button size="sm" variant="outline" disabled={busy} onClick={() => { void action("reauthorize") }}>Reauthorize continuation</Button>}
              <Button size="sm" variant="outline" disabled={busy} onClick={() => { void action("cancel") }}>Cancel scheduled resume</Button>
            </div>
          )}
          {error && <span role="alert">{error}</span>}
        </div>
      </RateLimitBanner>
    </div>
  )
}
