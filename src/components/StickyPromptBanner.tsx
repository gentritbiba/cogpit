import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ChevronUp, MessageSquareText } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { TimelineHandle } from "@/components/timeline/VirtualizedTimeline"
import type { Turn, UserContent } from "../../shared/session/types"
import type { SessionView } from "../../shared/session/sessionDigest"
import { getUserMessageImages, getUserMessageText } from "../../shared/session/parser"
import { composerPromptText } from "../../shared/session/composerContext"
import {
  extractCommandArgs,
  extractCommandName,
  isReaderPrompt,
  parseInterrupts,
  parseLocalCommandOutputs,
  parseTaskNotifications,
  promptSource,
  stripSystemTags,
} from "@/lib/userMessageContent"

interface StickyPromptBannerProps {
  session: SessionView
  scrollContainerRef: React.RefObject<HTMLElement | null>
  timelineRef: React.RefObject<TimelineHandle | null>
}

/** Where one of the reader's messages is: its turn, and the `data-reader-prompt` key of its bubble. */
interface MessageAddress {
  turnIndex: number
  key: string
}

interface ReaderMessage {
  key: string
  text: string
}

const TURN_SELECTOR = "[data-turn-index]"
const READER_SELECTOR = "[data-reader-prompt]"
const POSITION_EPSILON = 1
const PREVIEW_LENGTH = 180
/** How long a jump past the rendered turns waits for the virtualizer to settle the message, in frames. */
const SETTLE_FRAMES = 30

function firstLine(text: string): string {
  const line = text.split("\n")[0]
  return line.length > PREVIEW_LENGTH ? `${line.slice(0, PREVIEW_LENGTH)}...` : line
}

/** The reader's message as one line, or null when someone else wrote it. */
function readerMessageText(content: UserContent): string | null {
  const raw = getUserMessageText(content)
  const images = getUserMessageImages(content).length
  if (!isReaderPrompt(promptSource(raw), images)) return null

  // A prompt can quote a background task's report back at the agent. Banner
  // space belongs to what the reader typed, so the report comes off first.
  const typed = composerPromptText(raw)
  const { remainingText } = parseTaskNotifications(stripSystemTags(typed))
  const words = parseInterrupts(parseLocalCommandOutputs(remainingText).remainingText).remainingText
  if (words) return firstLine(words)

  const command = extractCommandName(typed)
  if (command) {
    const args = extractCommandArgs(typed)
    return args ? `/${command} ${args}` : `/${command}`
  }
  return images > 0 ? "Image attachment" : "Attached context"
}

const readerMessagesCache = new WeakMap<Turn, { blockCount: number; messages: ReaderMessage[] }>()

/** What the reader sent in a turn, in timeline order: the prompt that opened it, then any sent mid-turn. */
function readerMessages(turn: Turn): ReaderMessage[] {
  const cached = readerMessagesCache.get(turn)
  if (cached?.blockCount === turn.contentBlocks.length) return cached.messages

  const messages: ReaderMessage[] = []
  const opening = turn.userMessage && readerMessageText(turn.userMessage)
  if (opening) messages.push({ key: "prompt", text: opening })
  turn.contentBlocks.forEach((block, index) => {
    if (block.kind !== "queued_prompt") return
    const text = readerMessageText(block.content)
    if (text) messages.push({ key: String(index), text })
  })
  readerMessagesCache.set(turn, { blockCount: turn.contentBlocks.length, messages })
  return messages
}

/**
 * The reader's latest message that the viewport has scrolled past, or null
 * while it is still in view. Anything nobody typed, such as a crew chat post
 * or a session reporting back, is passed over.
 */
function scrolledPastMessage(container: HTMLElement, turns: Turn[]): MessageAddress | null {
  const rootTop = visibleTop(container) + POSITION_EPSILON
  let activeTurn: HTMLElement | null = null
  for (const turn of container.querySelectorAll<HTMLElement>(TURN_SELECTOR)) {
    if (turn.getBoundingClientRect().top > rootTop) break
    activeTurn = turn
  }
  if (!activeTurn) return null

  const turnIndex = Number(activeTurn.dataset.turnIndex)
  if (!Number.isInteger(turnIndex)) return null

  const bubbles = activeTurn.querySelectorAll<HTMLElement>(READER_SELECTOR)
  for (let index = bubbles.length - 1; index >= 0; index--) {
    const rect = bubbles[index].getBoundingClientRect()
    if (rect.top > rootTop) continue
    return rect.bottom > rootTop ? null : { turnIndex, key: bubbles[index].dataset.readerPrompt! }
  }
  // The reader opened this turn and their prompt is just below the top.
  if (bubbles[0]?.dataset.readerPrompt === "prompt") return null

  // None in this turn starts above the viewport, so it is the last one sent
  // earlier, which the virtualizer may not have rendered.
  for (let index = Math.min(turnIndex, turns.length) - 1; index >= 0; index--) {
    const last = readerMessages(turns[index]).at(-1)
    if (last) return { turnIndex: index, key: last.key }
  }
  return null
}

/** Where the viewport starts below the session chrome floating over it, which the scroller's `scroll-padding-top` reserves. */
function visibleTop(container: HTMLElement): number {
  return container.getBoundingClientRect().top + (parseFloat(getComputedStyle(container).scrollPaddingTop) || 0)
}

function bubbleAt(container: HTMLElement, { turnIndex, key }: MessageAddress): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-turn-index="${turnIndex}"] [data-reader-prompt="${key}"]`)
}

function scrollTopOf(container: HTMLElement, element: HTMLElement): number {
  return Math.max(0, container.scrollTop + element.getBoundingClientRect().top - visibleTop(container))
}

/** Lands on a message once the virtualizer has rendered it and stopped moving it. */
function landWhenSettled(container: HTMLElement, address: MessageAddress, framesLeft = SETTLE_FRAMES, lastTop?: number): void {
  requestAnimationFrame(() => {
    const bubble = bubbleAt(container, address)
    const top = bubble ? scrollTopOf(container, bubble) : undefined
    if (top !== undefined && lastTop !== undefined && Math.abs(top - lastTop) < POSITION_EPSILON) {
      container.scrollTo({ top })
      return
    }
    if (framesLeft > 0) landWhenSettled(container, address, framesLeft - 1, top)
  })
}

export const StickyPromptBanner = memo(function StickyPromptBanner({
  session,
  scrollContainerRef,
  timelineRef,
}: StickyPromptBannerProps) {
  const [sticky, setSticky] = useState<MessageAddress & { sessionId: string } | null>(null)
  const turnsRef = useRef(session.turns)
  useLayoutEffect(() => {
    turnsRef.current = session.turns
  }, [session.turns])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    let frame: number | null = null
    const update = () => {
      frame = null
      const address = scrolledPastMessage(container, turnsRef.current)
      setSticky((current) => {
        if (address === null) return null
        if (current?.sessionId === session.sessionId && current.turnIndex === address.turnIndex && current.key === address.key) {
          return current
        }
        return { sessionId: session.sessionId, ...address }
      })
    }
    const scheduleUpdate = () => {
      if (frame === null) frame = requestAnimationFrame(update)
    }

    setSticky(null)
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

  const message = useMemo(() => {
    if (!sticky || sticky.sessionId !== session.sessionId) return null
    const turn = session.turns[sticky.turnIndex]
    const text = turn && readerMessages(turn).find((candidate) => candidate.key === sticky.key)?.text
    return text ? { ...sticky, text } : null
  }, [session.sessionId, session.turns, sticky])

  if (!message) return null

  const scrollToMessage = () => {
    const container = scrollContainerRef.current
    if (!container) return
    const bubble = bubbleAt(container, message)
    if (bubble) {
      container.scrollTo({ top: scrollTopOf(container, bubble), behavior: "smooth" })
      return
    }
    if (timelineRef.current?.scrollToTurn(message.turnIndex)) landWhenSettled(container, message)
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={`Scroll to your message in turn ${message.turnIndex + 1}`}
      title={message.text}
      className="motion-slide-down-in absolute left-1/2 top-12 z-20 h-9 max-w-[calc(100%-5rem)] -translate-x-1/2 justify-start gap-2 rounded-full bg-popover px-3 text-left shadow-sm"
      onClick={scrollToMessage}
    >
      <MessageSquareText data-icon="inline-start" />
      <span className="shrink-0 font-mono text-xs text-muted-foreground">
        Turn {message.turnIndex + 1}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-normal text-foreground/80">
        {message.text}
      </span>
      <ChevronUp data-icon="inline-end" className="ml-auto" />
    </Button>
  )
})
