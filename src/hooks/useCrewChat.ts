import { useCallback, useRef, useState } from "react"
import { authFetch, jsonFetch } from "@/lib/auth"
import { fetchIfChanged } from "@/lib/conditionalFetch"
import { jsonEqual } from "@/lib/jsonEqual"
import { useVisiblePolling } from "./useVisiblePolling"
import type { CrewChatMessage, CrewChatPage, CrewChatPageResponse } from "../../shared/contracts/crewChat"

const POLL_MS = 2_000

/** What the chat shows beside its messages. */
export type CrewChatView = Omit<CrewChatPage, "messages">

async function checked(response: Response): Promise<Response> {
  if (response.ok) return response
  const body = await response.json().catch(() => null) as { error?: string } | null
  throw new Error(body?.error || "Couldn't update crew chat.")
}

function mergeMessages(current: CrewChatMessage[], incoming: readonly CrewChatMessage[]): CrewChatMessage[] {
  if (incoming.length === 0) return current
  return [...new Map([...current, ...incoming].map((message) => [message.sequence, message])).values()].sort((a, b) => a.sequence - b.sequence)
}

/** The page to show after a read, keeping the members, and the page itself, when they did not change. */
export function nextChatPage(current: CrewChatView | null, next: CrewChatPageResponse): CrewChatView {
  let members = next.members ?? current?.members ?? []
  if (current && next.members) {
    const unchanged = next.membersVersion !== undefined && current.membersVersion !== undefined
      ? next.membersVersion === current.membersVersion
      : jsonEqual(current.members, next.members)
    if (unchanged) members = current.members
  }
  const membersVersion = next.membersVersion ?? (next.members ? undefined : current?.membersVersion)
  if (
    current && members === current.members && membersVersion === current.membersVersion && current.rootId === next.rootId
    && current.nextCursor === next.nextCursor && current.hasMore === next.hasMore && current.canPost === next.canPost
  ) return current
  return {
    rootId: next.rootId,
    members,
    nextCursor: next.nextCursor,
    hasMore: next.hasMore,
    canPost: next.canPost,
    ...(membersVersion !== undefined && { membersVersion }),
  }
}

/**
 * Mounted by crew root so moving between members preserves chat and drafts.
 * Read only while `active` (the chat is on screen) and the tab is visible;
 * coming back catches up from the last message seen.
 */
export function useCrewChat(rootId: string, active = true) {
  const [page, setPage] = useState<CrewChatView | null>(null)
  const [messages, setMessages] = useState<CrewChatMessage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [posting, setPosting] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasOlder, setHasOlder] = useState(false)
  const [busyMembers, setBusyMembers] = useState<ReadonlySet<string>>(new Set())
  const requestCounter = useRef(0)
  const postAttempt = useRef<{ text: string; id: string } | null>(null)
  const postInFlight = useRef(false)
  const olderInFlight = useRef(false)
  const memberInFlight = useRef(new Set<string>())
  const initialized = useRef(false)
  const latestCursor = useRef<number | null>(null)
  const etag = useRef<string | null>(null)
  const membersVersion = useRef<string | null>(null)

  const query = useCallback((params: Record<string, string | number>) => {
    const search = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]))
    if (membersVersion.current) search.set("knownMembers", membersVersion.current)
    return `/api/crew-chat/${encodeURIComponent(rootId)}?${search}`
  }, [rootId])

  const poll = useCallback(async (isActive: () => boolean) => {
    const request = ++requestCounter.current
    try {
      const cursor = latestCursor.current
      const result = await fetchIfChanged<CrewChatPageResponse>(
        cursor === null ? `/api/crew-chat/${encodeURIComponent(rootId)}` : query({ after: cursor, limit: 100 }),
        etag.current,
      )
      if (!isActive() || request !== requestCounter.current) return
      if (result.kind === "failed") throw new Error("Couldn't load crew chat.")
      if (result.kind === "changed") {
        const next = result.value
        etag.current = result.etag
        membersVersion.current = next.membersVersion ?? null
        setPage((current) => nextChatPage(current, next))
        setMessages((current) => mergeMessages(current, next.messages))
        latestCursor.current = next.nextCursor
        if (!initialized.current) { initialized.current = true; setHasOlder(next.hasMore) }
      }
      setError(null)
    } catch (cause) { if (isActive() && request === requestCounter.current) setError(cause instanceof Error ? cause.message : "Couldn't load crew chat.") }
  }, [query, rootId])
  useVisiblePolling(active ? poll : null, POLL_MS)

  const post = useCallback(async (text: string): Promise<boolean> => {
    if (postInFlight.current) return false
    postInFlight.current = true
    setPosting(true)
    if (postAttempt.current?.text !== text) postAttempt.current = { text, id: crypto.randomUUID() }
    try {
      const response = await checked(await jsonFetch(`/api/crew-chat/${encodeURIComponent(rootId)}`, { text, commandId: postAttempt.current.id }))
      const result = await response.json() as { message: CrewChatMessage; pending: { sessionId: string }[] }
      requestCounter.current++
      setMessages((current) => mergeMessages(current, [result.message]))
      postAttempt.current = null
      setError(result.pending.length ? "Message saved. Some members are unavailable; delivery will retry." : null)
      return true
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't send the message."); return false }
    finally { postInFlight.current = false; setPosting(false) }
  }, [rootId])

  const setListening = useCallback(async (sessionId: string, listening: boolean) => {
    if (memberInFlight.current.has(sessionId)) return
    memberInFlight.current.add(sessionId)
    setBusyMembers((current) => new Set(current).add(sessionId))
    try {
      await checked(await jsonFetch(`/api/crew-chat/${encodeURIComponent(rootId)}`, { sessionId, listening }, { method: "PATCH" }))
      requestCounter.current++
      setPage((current) => current && ({ ...current, members: current.members.map((member) => member.sessionId === sessionId ? { ...member, listening } : member) }))
      setError(null)
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't change listening.") }
    finally {
      memberInFlight.current.delete(sessionId)
      setBusyMembers((current) => { const next = new Set(current); next.delete(sessionId); return next })
    }
  }, [rootId])

  const older = useCallback(async () => {
    if (!messages.length || olderInFlight.current) return
    olderInFlight.current = true
    setLoadingOlder(true)
    try {
      const response = await checked(await authFetch(query({ before: messages[0]!.sequence })))
      const next = await response.json() as CrewChatPageResponse
      setMessages((current) => mergeMessages(current, next.messages))
      setHasOlder(next.hasMore)
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't load older messages.") }
    finally { olderInFlight.current = false; setLoadingOlder(false) }
  }, [messages, query])

  return { page, messages, error, posting, busyMembers, hasOlder, loadingOlder, post, setListening, older }
}
