import { useCallback, useEffect, useMemo, useRef } from "react"
import type { SessionView } from "../../shared/session/sessionDigest"

interface UsePendingPromptsOpts {
  session: SessionView | null
  pendingMessages: string[]
  consumePending: (count?: number) => void
}

/**
 * Retires the optimistic previews of messages the reader sent once the
 * transcript shows them: a new turn per message, or the persisted copy of a
 * prompt queued mid-turn.
 */
export function usePendingPrompts({ session, pendingMessages, consumePending }: UsePendingPromptsOpts) {
  const prevTurnCountRef = useRef(0)
  const pendingCount = pendingMessages.length

  const resetTurnCount = useCallback((count: number) => {
    prevTurnCountRef.current = count
  }, [])

  const persistedQueuedPrompts = useMemo(() => session?.turns.flatMap((turn) => (
    turn.contentBlocks.flatMap((block) => block.kind === "queued_prompt"
      ? [{ id: JSON.stringify([block.timestamp ?? "", block.content]), content: block.content }]
      : [])
  )) ?? [], [session?.turns])
  const queuedPromptStateRef = useRef<{ sessionId: string | null; ids: Set<string> } | null>(null)

  // Prompts queued mid-turn are first shown optimistically, then persisted as
  // queue-operation entries. Once the parser exposes the persisted copy,
  // consume the matching number of optimistic previews to avoid duplicates.
  useEffect(() => {
    const sessionId = session?.sessionId ?? null
    const previous = queuedPromptStateRef.current
    const ids = new Set(persistedQueuedPrompts.map((prompt) => prompt.id))
    if (!previous || previous.sessionId !== sessionId) {
      queuedPromptStateRef.current = { sessionId, ids }
      return
    }

    const added = persistedQueuedPrompts.filter((prompt) => !previous.ids.has(prompt.id))
    queuedPromptStateRef.current = { sessionId, ids }
    if (added.length === 0 || pendingCount === 0) return

    let matched = 0
    for (const prompt of added) {
      const pending = pendingMessages[matched]
      if (pending === prompt.content || (pending?.trim() === "" && prompt.content.length > 0)) {
        matched++
      }
    }
    if (matched > 0) consumePending(matched)
  }, [session?.sessionId, persistedQueuedPrompts, pendingMessages, pendingCount, consumePending])

  const turnCount = session?.turns.length ?? 0
  useEffect(() => {
    if (turnCount === 0) return
    const newTurns = turnCount - prevTurnCountRef.current
    if (newTurns > 0 && pendingCount > 0) consumePending(Math.min(newTurns, pendingCount))
    prevTurnCountRef.current = turnCount
  }, [turnCount, pendingCount, consumePending])

  return resetTurnCount
}
