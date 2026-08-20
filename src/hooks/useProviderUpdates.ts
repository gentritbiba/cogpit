import { useCallback, useEffect, useState } from "react"

import { useLocalStorage } from "@/hooks/useLocalStorage"
import {
  fetchProviderUpdates,
  nextDismissals,
  pendingProviderUpdates,
  providerUpdateDismissKey,
  runProviderUpdate,
  PROVIDER_UPDATE_DISMISSALS_KEY,
  type ProviderUpdateId,
  type ProviderUpdateInfo,
  type ProviderUpdateRunResult,
} from "@/lib/providerUpdates"

/** The server caches the registry answer for an hour; re-asking sooner is noise. */
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000

export type ProviderUpdateOutcome = Pick<
  ProviderUpdateRunResult,
  "provider" | "status" | "message" | "output"
>

export interface ProviderUpdatesState {
  /** Outdated providers the user has not dismissed at this version. */
  pending: ProviderUpdateInfo[]
  updating: ProviderUpdateId | null
  outcome: ProviderUpdateOutcome | null
  update: (provider: ProviderUpdateId) => Promise<void>
  dismiss: (info: ProviderUpdateInfo) => void
  clearOutcome: () => void
}

export function useProviderUpdates(): ProviderUpdatesState {
  const [providers, setProviders] = useState<ProviderUpdateInfo[]>([])
  const [dismissed, setDismissed] = useLocalStorage<string[]>(PROVIDER_UPDATE_DISMISSALS_KEY, [])
  const [updating, setUpdating] = useState<ProviderUpdateId | null>(null)
  const [outcome, setOutcome] = useState<ProviderUpdateOutcome | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const check = () => {
      fetchProviderUpdates(controller.signal)
        .then(setProviders)
        // An unreachable registry or server is not worth surfacing: the banner
        // stays hidden until a later check succeeds.
        .catch(() => undefined)
    }

    check()
    const timer = setInterval(check, RECHECK_INTERVAL_MS)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [])

  const update = useCallback(async (provider: ProviderUpdateId) => {
    setUpdating(provider)
    setOutcome(null)
    try {
      const result = await runProviderUpdate(provider)
      setOutcome(result)
      setProviders((previous) =>
        previous.map((info) => (info.provider === provider ? result.info : info)),
      )
    } catch (error) {
      setOutcome({
        provider,
        status: "failed",
        message: error instanceof Error ? error.message : "Update failed.",
        output: null,
      })
    } finally {
      setUpdating(null)
    }
  }, [])

  const dismiss = useCallback(
    (info: ProviderUpdateInfo) => {
      setDismissed((previous) => nextDismissals(previous, providerUpdateDismissKey(info)))
    },
    [setDismissed],
  )

  return {
    pending: pendingProviderUpdates(providers, dismissed),
    updating,
    outcome,
    update,
    dismiss,
    clearOutcome: useCallback(() => setOutcome(null), []),
  }
}
