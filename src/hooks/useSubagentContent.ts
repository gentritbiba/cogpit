import { useState, useEffect, useRef, useMemo } from "react"
import { authFetch } from "@/lib/auth"
import { useSessionContext } from "@/contexts/SessionContext"
import type { SubAgentMessage, ToolCall, ContentBlock } from "@/lib/types"

function extractToolResultText(content: string | ContentBlock[] | undefined | null): string {
  if (!content) return ""
  if (typeof content === "string") return content
  return content
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("\n")
}

/**
 * Parses a subagent JSONL file into SubAgentMessage[].
 * Handles both user (tool_result) and assistant (thinking/text/tool_use) messages.
 */
export function parseSubagentJsonl(jsonlText: string, agentId: string): SubAgentMessage[] {
  const messages: SubAgentMessage[] = []
  const pendingToolCalls = new Map<string, ToolCall>()

  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(trimmed)
    } catch {
      continue
    }

    const type = raw.type as string
    if (type !== "user" && type !== "assistant") continue

    const message = raw.message as { role: string; content: unknown; model?: string; id?: string; usage?: Record<string, number> }
    if (!message) continue

    const content = message.content
    const timestamp = (raw.timestamp as string) ?? ""

    if (type === "assistant") {
      const msg: SubAgentMessage = {
        agentId,
        agentName: null,
        subagentType: null,
        type: "assistant",
        content,
        toolCalls: [],
        thinking: [],
        text: [],
        timestamp,
        tokenUsage: message.usage ? {
          input_tokens: message.usage.input_tokens ?? 0,
          output_tokens: message.usage.output_tokens ?? 0,
          cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
        } : null,
        model: message.model ?? null,
        isBackground: true,
      }

      if (Array.isArray(content)) {
        for (const block of content as ContentBlock[]) {
          if (block.type === "thinking") {
            msg.thinking.push(block.thinking)
          } else if (block.type === "text") {
            msg.text.push(block.text)
          } else if (block.type === "tool_use") {
            const tc: ToolCall = {
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown>,
              result: null,
              isError: false,
              timestamp,
            }
            msg.toolCalls.push(tc)
            pendingToolCalls.set(block.id, tc)
          }
        }
      }

      messages.push(msg)
    } else if (type === "user") {
      if (Array.isArray(content)) {
        for (const block of content as ContentBlock[]) {
          if (block.type === "tool_result") {
            const tc = pendingToolCalls.get(block.tool_use_id)
            if (tc) {
              tc.result = extractToolResultText(block.content)
              tc.isError = block.is_error ?? false
            }
          }
        }
      }
    }
  }

  return messages
}

// Module-level cache: keyed by "dirName/sessionId/agentId"
const subagentCache = new Map<string, SubAgentMessage[]>()

/**
 * Lazy-loads subagent JSONL content when background agents only have
 * an async_launched summary (v2.1.63+ format without inline agent_progress).
 *
 * Returns the original messages if they already have content,
 * or enriched messages from the subagent JSONL file.
 */
export function useSubagentContent(messages: SubAgentMessage[], enabled: boolean): {
  enrichedMessages: SubAgentMessage[]
  isLoading: boolean
} {
  const { session, sessionSource, isLive } = useSessionContext()
  const [loaded, setLoaded] = useState<Map<string, SubAgentMessage[]>>(new Map())
  const [isLoading, setIsLoading] = useState(false)
  const fetchedRef = useRef(new Set<string>())

  // Identify agents that need lazy loading: summary-only messages with no detailed content.
  // Non-live sessions: load async_launched agents.
  // Live sessions: load agents that have COMPLETED (durationMs set by toolUseResult).
  // Running agents are not loaded here -- Phase 3 polling handles those.
  const agentsToLoad = useMemo(
    () => messages.filter((m) => {
      if (m.text.length > 0 || m.thinking.length > 0 || m.toolCalls.length > 0) return false
      return isLive ? m.durationMs != null : m.status === "async_launched"
    }),
    [isLive, messages]
  )

  const dirName = sessionSource?.dirName
  const sessionId = session?.sessionId

  useEffect(() => {
    if (!enabled || !dirName || !sessionId || agentsToLoad.length === 0) return

    const toFetch: Array<{ agentId: string; cacheKey: string }> = []
    for (const m of agentsToLoad) {
      const cacheKey = `${dirName}/${sessionId}/${m.agentId}`
      if (fetchedRef.current.has(cacheKey)) continue
      if (subagentCache.has(cacheKey)) {
        // Already cached at module level — pull into local state
        setLoaded((prev) => {
          const next = new Map(prev)
          next.set(m.agentId, subagentCache.get(cacheKey)!)
          return next
        })
        fetchedRef.current.add(cacheKey)
        continue
      }
      toFetch.push({ agentId: m.agentId, cacheKey })
    }

    if (toFetch.length === 0) return

    let cancelled = false
    setIsLoading(true)

    async function fetchAll() {
      const results = new Map<string, SubAgentMessage[]>()
      await Promise.all(
        toFetch.map(async ({ agentId, cacheKey }) => {
          try {
            const url = `/api/sessions/${encodeURIComponent(dirName!)}/${encodeURIComponent(sessionId!)}` +
              `/subagents/agent-${encodeURIComponent(agentId)}.jsonl`
            const res = await authFetch(url)
            if (!res.ok) return
            const text = await res.text()
            const parsed = parseSubagentJsonl(text, agentId)
            subagentCache.set(cacheKey, parsed)
            fetchedRef.current.add(cacheKey)
            results.set(agentId, parsed)
          } catch {
            // Subagent file may not exist — silently skip, allowing retry on next expansion
          }
        })
      )
      if (!cancelled && results.size > 0) {
        setLoaded((prev) => {
          const next = new Map(prev)
          for (const [id, msgs] of results) next.set(id, msgs)
          return next
        })
      }
      if (!cancelled) setIsLoading(false)
    }

    fetchAll()
    return () => { cancelled = true }
  }, [enabled, dirName, sessionId, agentsToLoad])

  const enrichedMessages = useMemo(() => {
    if (loaded.size === 0 && agentsToLoad.length === 0) return messages

    const result: SubAgentMessage[] = []
    for (const m of messages) {
      const loadedMsgs = loaded.get(m.agentId)
      if (loadedMsgs && loadedMsgs.length > 0 && (m.status === "async_launched" || m.durationMs != null)) {
        // Carry summary stats from the launch event onto the first loaded message
        const first: SubAgentMessage = {
          ...loadedMsgs[0],
          durationMs: m.durationMs,
          toolUseCount: m.toolUseCount,
          status: m.status,
          prompt: m.prompt,
          agentName: m.agentName,
          subagentType: m.subagentType,
        }
        result.push(first, ...loadedMsgs.slice(1))
      } else {
        result.push(m)
      }
    }
    return result
  }, [messages, loaded, agentsToLoad])

  return { enrichedMessages, isLoading }
}
