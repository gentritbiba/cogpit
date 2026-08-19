import { memo, useEffect, useMemo, useState } from "react"
import { ChevronUp, MessageSquareText } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ParsedSession, Turn } from "@/lib/types"
import { getUserMessageText } from "@/lib/parser"
import { parseTeammateMessage } from "@/lib/teammateMessage"
import { extractCommandArgs, extractCommandName, stripSystemTags } from "@/lib/userMessageContent"

interface StickyPromptBannerProps {
  session: ParsedSession
  scrollContainerRef: React.RefObject<HTMLElement | null>
}

interface StickyTurn {
  sessionId: string
  index: number
}

const TURN_SELECTOR = "[data-turn-index]"
const PROMPT_SELECTOR = "[data-turn-prompt]"
const POSITION_EPSILON = 1
const PROMPT_HEIGHT_FALLBACK = 120
const PREVIEW_LENGTH = 180

function promptPreview(turn: Turn): string | null {
  if (!turn.userMessage) return null

  const raw = getUserMessageText(turn.userMessage)
  const { text: unwrapped } = parseTeammateMessage(raw)
  const clean = stripSystemTags(unwrapped)

  if (!clean) {
    const command = extractCommandName(raw)
    if (!command) return null
    const args = extractCommandArgs(raw)
    return args ? `/${command} ${args}` : `/${command}`
  }

  const firstLine = clean.split("\n")[0]
  return firstLine.length > PREVIEW_LENGTH
    ? `${firstLine.slice(0, PREVIEW_LENGTH)}...`
    : firstLine
}

function findPrompt(turns: Turn[], startIndex: number): { index: number; text: string } | null {
  for (let index = startIndex; index >= 0; index--) {
    const turn = turns[index]
    if (!turn) continue
    const text = promptPreview(turn)
    if (text) return { index, text }
  }
  return null
}

function hiddenPromptTurnIndex(container: HTMLElement): number | null {
  const rootTop = container.getBoundingClientRect().top
  let activeTurn: HTMLElement | null = null
  let activeTurnTop = 0

  for (const turn of container.querySelectorAll<HTMLElement>(TURN_SELECTOR)) {
    const top = turn.getBoundingClientRect().top
    if (top > rootTop + POSITION_EPSILON) break
    activeTurn = turn
    activeTurnTop = top
  }

  if (!activeTurn) return null

  const index = Number(activeTurn.dataset.turnIndex)
  if (!Number.isInteger(index)) return null

  const prompt = activeTurn.querySelector<HTMLElement>(PROMPT_SELECTOR)
  const promptIsVisible = prompt
    ? prompt.getBoundingClientRect().bottom > rootTop + POSITION_EPSILON
    : activeTurnTop + PROMPT_HEIGHT_FALLBACK > rootTop

  return promptIsVisible ? null : index
}

export const StickyPromptBanner = memo(function StickyPromptBanner({
  session,
  scrollContainerRef,
}: StickyPromptBannerProps) {
  const [stickyTurn, setStickyTurn] = useState<StickyTurn | null>(null)

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    let frame: number | null = null
    const update = () => {
      frame = null
      const index = hiddenPromptTurnIndex(container)
      setStickyTurn((current) => {
        if (index === null) return null
        if (current?.sessionId === session.sessionId && current.index === index) return current
        return { sessionId: session.sessionId, index }
      })
    }
    const scheduleUpdate = () => {
      if (frame === null) frame = requestAnimationFrame(update)
    }

    setStickyTurn(null)
    container.addEventListener("scroll", scheduleUpdate, { passive: true })

    const mutationObserver = new MutationObserver(scheduleUpdate)
    mutationObserver.observe(container, { childList: true, subtree: true })

    const resizeObserver = new ResizeObserver(scheduleUpdate)
    resizeObserver.observe(container)
    if (container.firstElementChild) resizeObserver.observe(container.firstElementChild)

    scheduleUpdate()
    return () => {
      container.removeEventListener("scroll", scheduleUpdate)
      mutationObserver.disconnect()
      resizeObserver.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [scrollContainerRef, session.sessionId])

  const prompt = useMemo(() => {
    if (!stickyTurn || stickyTurn.sessionId !== session.sessionId) return null
    return findPrompt(session.turns, stickyTurn.index)
  }, [session.sessionId, session.turns, stickyTurn])

  if (!prompt) return null

  const scrollToPrompt = () => {
    const container = scrollContainerRef.current
    if (!container) return
    const turn = container.querySelector<HTMLElement>(
      `[data-turn-index="${prompt.index}"]`,
    )
    const target = turn?.querySelector<HTMLElement>(PROMPT_SELECTOR) ?? turn
    if (!target) return

    const top = container.scrollTop
      + target.getBoundingClientRect().top
      - container.getBoundingClientRect().top
    container.scrollTo({ top: Math.max(0, top), behavior: "smooth" })
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={`Scroll to turn ${prompt.index + 1} prompt`}
      title={prompt.text}
      className="absolute inset-x-0 top-0 z-30 h-9 justify-start rounded-none border-x-0 px-3 text-left"
      onClick={scrollToPrompt}
    >
      <MessageSquareText data-icon="inline-start" />
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
        Turn {prompt.index + 1}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs font-normal text-foreground/80">
        {prompt.text}
      </span>
      <ChevronUp data-icon="inline-end" className="ml-auto" />
    </Button>
  )
})
