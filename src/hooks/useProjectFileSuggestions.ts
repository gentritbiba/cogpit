import { useEffect, useState } from "react"
import { authFetch } from "@/lib/auth"

/** Extract the string file list from a `/api/project-files` response body. */
export function parseProjectFilesResponse(data: unknown): string[] {
  const files = (data as { files?: unknown }).files
  return Array.isArray(files) ? files.filter((file): file is string => typeof file === "string") : []
}

export function useProjectFileSuggestions(
  cwd: string | null | undefined,
  query: string,
  enabled: boolean,
) {
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled || !cwd) {
      setFiles([])
      setLoading(false)
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setLoading(true)
      try {
        const response = await authFetch(
          `/api/project-files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}&limit=30`,
          { signal: controller.signal },
        )
        if (!response.ok) throw new Error(`Request failed (${response.status})`)
        const data: unknown = await response.json()
        if (!controller.signal.aborted) setFiles(parseProjectFilesResponse(data))
      } catch {
        if (!controller.signal.aborted) setFiles([])
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, 120)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [cwd, enabled, query])

  return { files, loading }
}
