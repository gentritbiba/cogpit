import { useState, useEffect, useRef } from "react"
import { authFetch } from "@/lib/auth"

export interface SkillMeta {
  source: string
  description?: string
  filePath?: string
}

/** In-memory cache: cwd → { data, expiresAt } */
const cache = new Map<string, { data: Map<string, SkillMeta>; expiresAt: number }>()

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

function getCached(cwd: string): Map<string, SkillMeta> | null {
  const entry = cache.get(cwd)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    cache.delete(cwd)
    return null
  }
  return entry.data
}

function setCached(cwd: string, data: Map<string, SkillMeta>): void {
  cache.set(cwd, { data, expiresAt: Date.now() + CACHE_TTL_MS })
}

interface SlashSuggestionRaw {
  name: string
  description?: string
  type: string
  source: string
  filePath?: string
}

/**
 * Fetches skill metadata from `/api/slash-suggestions` and returns a Map
 * keyed by skill name, containing source, description, and filePath.
 * Results are cached per-cwd for 5 minutes.
 */
export function useSkillMetadata(cwd: string): Map<string, SkillMeta> {
  const [metadata, setMetadata] = useState<Map<string, SkillMeta>>(() => {
    if (!cwd) return new Map()
    return getCached(cwd) ?? new Map()
  })

  const fetchedCwdRef = useRef<string>("")

  useEffect(() => {
    if (!cwd) return

    // Return cached data immediately (no fetch needed)
    const cached = getCached(cwd)
    if (cached) {
      setMetadata(cached)
      return
    }

    fetchedCwdRef.current = cwd

    authFetch(`/api/slash-suggestions?cwd=${encodeURIComponent(cwd)}`)
      .then(async (res) => {
        if (fetchedCwdRef.current !== cwd) return
        if (!res.ok) return

        const data = await res.json() as { suggestions: SlashSuggestionRaw[] }
        const map = new Map<string, SkillMeta>()
        for (const s of data.suggestions ?? []) {
          if (s.type === "skill") {
            map.set(s.name, {
              source: s.source,
              description: s.description,
              filePath: s.filePath,
            })
          }
        }
        setCached(cwd, map)
        setMetadata(map)
      })
      .catch(() => { /* ignore fetch errors */ })
  }, [cwd])

  return metadata
}
