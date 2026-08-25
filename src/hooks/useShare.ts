import { useCallback, useEffect, useRef, useState } from "react"
import { authFetch } from "@/lib/auth"

/**
 * A shared session as `GET /api/shares` reports it. `lastAccessAt` is 0 until a
 * guest opens the link for the first time, and `guests` counts the guest tokens
 * currently connected, so both change under the UI without a reload.
 */
export interface HostShare {
  sessionId: string
  dirName: string
  fileName: string
  title: string
  createdAt: number
  lastAccessAt: number
  guests: number
}

export interface ShareApi {
  shares: HostShare[]
  /** The host API's own words when it refuses, e.g. network access is off. */
  error: string | null
  refresh: () => Promise<void>
  /** Mints a share and returns the passphrase, which is only ever readable here. */
  create: (sessionId: string) => Promise<string | null>
  regenerate: (sessionId: string) => Promise<string | null>
  revoke: (sessionId: string) => Promise<void>
  revokeAll: () => Promise<void>
}

const GENERIC_ERROR = "Could not reach the server"

/**
 * `authFetch` can reject *and* throw synchronously (a bad device prefix, a
 * mocked transport), so every call goes through here rather than a trailing
 * `.catch` that a synchronous throw would sail straight past.
 */
async function request(url: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await authFetch(url, init)
  } catch {
    return null
  }
}

async function errorFrom(res: Response | null): Promise<string> {
  const body = await res?.json().catch(() => null)
  const message = (body as { error?: unknown } | null)?.error
  return typeof message === "string" && message.length > 0 ? message : GENERIC_ERROR
}

/**
 * The host's view of every shared session: the share button reads its own row
 * out of it, the network settings list shows all of them. One hook rather than
 * two so a revoke from settings and the button's state can never disagree.
 */
export function useShares(): ShareApi {
  const [shares, setShares] = useState<HostShare[]>([])
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    const res = await request("/api/shares")
    if (!res?.ok) return
    const body = await res.json().catch(() => null)
    if (alive.current && Array.isArray(body)) setShares(body as HostShare[])
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const create = useCallback(async (sessionId: string): Promise<string | null> => {
    setError(null)
    const res = await request("/api/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    })

    if (!res?.ok) {
      if (alive.current) setError(await errorFrom(res))
      return null
    }

    const body = await res.json().catch(() => null) as
      { passphrase?: string; share?: HostShare } | null
    if (!body?.passphrase || !body.share) {
      if (alive.current) setError(GENERIC_ERROR)
      return null
    }

    const minted = body.share
    if (alive.current) {
      setShares((current) => [
        ...current.filter((s) => s.sessionId !== minted.sessionId),
        minted,
      ])
    }
    return body.passphrase
  }, [])

  const regenerate = useCallback(async (sessionId: string): Promise<string | null> => {
    setError(null)
    const res = await request(`/api/shares/${encodeURIComponent(sessionId)}/regenerate`, {
      method: "POST",
    })

    if (!res?.ok) {
      if (alive.current) setError(await errorFrom(res))
      return null
    }

    const body = await res.json().catch(() => null) as { passphrase?: string } | null
    if (!body?.passphrase) {
      if (alive.current) setError(GENERIC_ERROR)
      return null
    }
    // Rotating kicks the old guests; the count on screen is now stale.
    void refresh()
    return body.passphrase
  }, [refresh])

  const revoke = useCallback(async (sessionId: string): Promise<void> => {
    setError(null)
    const res = await request(`/api/shares/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    })

    if (!res?.ok) {
      if (alive.current) setError(await errorFrom(res))
      return
    }
    if (alive.current) setShares((current) => current.filter((s) => s.sessionId !== sessionId))
  }, [])

  const revokeAll = useCallback(async (): Promise<void> => {
    const ids = shares.map((share) => share.sessionId)
    for (const id of ids) await revoke(id)
  }, [shares, revoke])

  return { shares, error, refresh, create, regenerate, revoke, revokeAll }
}
