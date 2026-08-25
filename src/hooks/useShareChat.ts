import { useCallback, useState } from "react"
import type { ChatState } from "@/contexts/SessionContext"
import { interruptShare, sendShareMessage } from "@/lib/shareApi"

/**
 * The guest half of {@link usePtyChat}.
 *
 * Separate rather than shared because the host version's whole body is the part
 * a guest must not have: cwd, permissions, model, effort and the MCP selection.
 * The server strips those from a guest message anyway, so sending them would be
 * a second, weaker copy of a boundary that already exists — and a place for the
 * two to drift. This sends the message and nothing else.
 */
export function useShareChat(): ChatState {
  const [status, setStatus] = useState<ChatState["status"]>("idle")
  const [error, setError] = useState<string | undefined>()
  const [pendingMessages, setPendingMessages] = useState<string[]>([])

  const sendMessage = useCallback((
    text: string,
    images?: Array<{ data: string; mediaType: string }>,
  ) => {
    setPendingMessages((prev) => [...prev, text])
    setStatus("connected")
    setError(undefined)

    void sendShareMessage(text, images)
      .then((res) => {
        if (res.ok) {
          setStatus("idle")
          return
        }
        setError(`Request failed (${res.status})`)
        setStatus("error")
        setPendingMessages((prev) => prev.slice(0, -1))
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Unknown error")
        setStatus("error")
        setPendingMessages((prev) => prev.slice(0, -1))
      })
  }, [])

  const interrupt = useCallback(() => {
    void interruptShare().catch(() => {})
    setStatus("idle")
    setPendingMessages([])
  }, [])

  const consumePending = useCallback((count = 1) => {
    setPendingMessages((prev) => prev.slice(count))
  }, [])

  return {
    status,
    error,
    pendingMessages,
    isConnected: status === "connected",
    sendMessage,
    interrupt,
    stopAgent: interrupt,
    consumePending,
  }
}
