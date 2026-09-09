import { useCallback, useEffect, useState } from "react"

import { authFetch } from "@/lib/auth"
import { readError } from "@/lib/httpJson"
import type { AccountSwitchResult, AgentAccountsReport } from "../../shared/contracts/agentAccounts"
import type { AgentKind } from "../../shared/session/agent-descriptors"

export type AccountSwitchOutcome =
  | { kind: "switched"; result: AccountSwitchResult }
  | { kind: "failed"; error: string }

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function fetchReport(kind: AgentKind): Promise<AgentAccountsReport> {
  try {
    const res = await authFetch(`/api/agent-accounts/${kind}`)
    if (res.status === 404) return { status: "missing" }
    return res.ok ? await res.json() : { status: "error", error: await readError(res, `Request failed (${res.status})`) }
  } catch (err) {
    return { status: "error", error: messageOf(err) }
  }
}

/**
 * The logins an agent's switcher manages, plus the one action on them. `report`
 * stays null until the first answer, so a caller can avoid flashing a section
 * that turns out not to apply.
 */
export function useAgentAccounts(kind: AgentKind) {
  const [report, setReport] = useState<AgentAccountsReport | null>(null)
  const [switchingSlot, setSwitchingSlot] = useState<number | null>(null)
  const [outcome, setOutcome] = useState<AccountSwitchOutcome | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchReport(kind).then((data) => {
      if (!cancelled) setReport(data)
    })
    return () => {
      cancelled = true
    }
  }, [kind])

  const switchTo = useCallback(async (slot: number) => {
    setSwitchingSlot(slot)
    setOutcome(null)
    try {
      const res = await authFetch(`/api/agent-accounts/${kind}/switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot }),
      })
      if (!res.ok) {
        setOutcome({ kind: "failed", error: await readError(res, `Request failed (${res.status})`) })
        return
      }
      setOutcome({ kind: "switched", result: await res.json() })
      setReport(await fetchReport(kind))
    } catch (err) {
      setOutcome({ kind: "failed", error: messageOf(err) })
    } finally {
      setSwitchingSlot(null)
    }
  }, [kind])

  return { report, switchingSlot, outcome, switchTo }
}
