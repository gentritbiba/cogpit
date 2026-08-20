import { useEffect, useState } from "react"
import { authFetch } from "@/lib/auth"
import type { ModelRate, RateTable } from "@/lib/usagePricing"

interface RatesResponse {
  status?: string
  rates?: Record<string, ModelRate>
}

const EMPTY_RATES: RateTable = new Map()

// The table changes at most daily and every stats surface wants it; fetch
// once per page load and share the promise across hook instances.
let cached: RateTable | null = null
let inflight: Promise<RateTable> | null = null

async function fetchRates(): Promise<RateTable> {
  try {
    const res = await authFetch("/api/usage-cost/rates")
    if (!res.ok) return EMPTY_RATES
    const data = (await res.json()) as RatesResponse
    return new Map(Object.entries(data.rates ?? {}))
  } catch {
    return EMPTY_RATES
  }
}

/**
 * The LiteLLM model rate table, for pricing raw reported tokens client-side.
 * Empty until loaded (and when the server has no table): unpriced beats a
 * made-up number.
 */
export function useModelRates(): RateTable {
  const [rates, setRates] = useState<RateTable>(cached ?? EMPTY_RATES)

  useEffect(() => {
    if (cached !== null) return
    let alive = true
    inflight ??= fetchRates().then((table) => {
      // Only a non-empty table is worth memoising; a failed fetch should be
      // retried by the next mount instead of pinning "no rates" forever.
      if (table.size > 0) cached = table
      inflight = null
      return table
    })
    void inflight.then((table) => {
      if (alive) setRates(table)
    })
    return () => {
      alive = false
    }
  }, [])

  return rates
}
