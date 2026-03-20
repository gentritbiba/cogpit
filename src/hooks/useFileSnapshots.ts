import { useState, useEffect } from "react"
import { authFetch } from "@/lib/auth"

export interface FileSnapshotResult {
  before: string | null
  after: string | null
  loading: boolean
  error: string | null
  hasSnapshots: boolean
}

// Module-level cache — snapshots are immutable for past sessions
const cache = new Map<string, { before: string | null; after: string | null }>()

export function clearSnapshotCache() {
  cache.clear()
}

export function useFileSnapshots(sessionId: string, filePath: string): FileSnapshotResult {
  const [result, setResult] = useState<FileSnapshotResult>({
    before: null,
    after: null,
    loading: !!(sessionId && filePath),
    error: null,
    hasSnapshots: false,
  })

  useEffect(() => {
    if (!sessionId || !filePath) return

    const cacheKey = `${sessionId}:${filePath}`
    const cached = cache.get(cacheKey)
    if (cached) {
      setResult({
        before: cached.before,
        after: cached.after,
        loading: false,
        error: null,
        hasSnapshots: cached.before !== null || cached.after !== null,
      })
      return
    }

    let cancelled = false

    async function fetchSnapshots() {
      try {
        const encodedPath = encodeURIComponent(filePath)
        const res = await authFetch(`/api/file-snapshots/${encodeURIComponent(sessionId)}/${encodedPath}`)
        if (cancelled) return

        const data = await res.json()
        if (cancelled) return

        if (data === null) {
          cache.set(cacheKey, { before: null, after: null })
          setResult({ before: null, after: null, loading: false, error: null, hasSnapshots: false })
        } else {
          cache.set(cacheKey, { before: data.before, after: data.after })
          setResult({
            before: data.before,
            after: data.after,
            loading: false,
            error: null,
            hasSnapshots: data.before !== null || data.after !== null,
          })
        }
      } catch (err) {
        if (cancelled) return
        setResult({
          before: null,
          after: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
          hasSnapshots: false,
        })
      }
    }

    fetchSnapshots()
    return () => { cancelled = true }
  }, [sessionId, filePath])

  return result
}
