import { useCallback, useState } from "react"

import { authFetch } from "@/lib/auth"
import { readError } from "@/lib/httpJson"
import type {
  EmbeddingSettingsInput,
  EmbeddingSettingsReport,
  EmbeddingSettingsRequest,
  EmbeddingTestResult,
} from "../../shared/contracts/memoryEmbeddings"
import { messageOf, useReport } from "./useReport"

const ROUTE = "/api/memory-embeddings"

function post(body: EmbeddingSettingsRequest): Promise<Response> {
  return authFetch(ROUTE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
}

/** The host's embedding endpoint for session search: read it, test one, save one, or turn it off. */
export function useMemoryEmbeddings() {
  const { state, refresh, supersede, land } = useReport<EmbeddingSettingsReport>(ROUTE)
  const [busy, setBusy] = useState<"save" | "test" | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** Resolves true once the change is saved. */
  const change = useCallback(async (body: EmbeddingSettingsRequest): Promise<boolean> => {
    setBusy("save")
    setError(null)
    const token = supersede()
    try {
      const res = await post(body)
      if (!res.ok) {
        setError(await readError(res, `Request failed (${res.status})`))
        return false
      }
      land(token, (await res.json()) as EmbeddingSettingsReport)
      return true
    } catch (err) {
      setError(messageOf(err))
      return false
    } finally {
      setBusy(null)
    }
  }, [supersede, land])

  const save = useCallback((settings: EmbeddingSettingsInput) => change({ action: "save", settings }), [change])
  const turnOff = useCallback(() => change({ action: "off" }), [change])

  const test = useCallback(async (settings: EmbeddingSettingsInput): Promise<EmbeddingTestResult> => {
    setBusy("test")
    try {
      const res = await post({ action: "test", settings })
      return res.ok ? await res.json() : { ok: false, error: await readError(res, `Request failed (${res.status})`) }
    } catch (err) {
      return { ok: false, error: messageOf(err) }
    } finally {
      setBusy(null)
    }
  }, [])

  return { state, busy, error, refresh, save, turnOff, test }
}
