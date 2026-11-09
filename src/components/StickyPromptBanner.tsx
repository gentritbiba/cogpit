import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronUp, MessageSquareText } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { TimelineHandle } from "@/lib/timelineScroll/types"
import { turnKeysOf } from "@/lib/timelineScroll/turnKeys"
import { revealKey, useTimelineStore } from "@/components/timeline/disclosure"
import type { ParsedSession, Turn, UserContent } from "../../shared/session/types"
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
  session: ParsedSession
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

const READER_SELECTOR = "[data-reader-prompt]"
const POSITION_EPSILON = 1
const PREVIEW_LENGTH = 180

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
 * or a session reporting back, is passed over. `firstVisibleKey` is the turn
 * at the top of the viewport, as the timeline reports it.
 */
function scrolledPastMessage(container: HTMLElement, turns: Turn[], keys: string[], firstVisibleKey: string | null): MessageAddress | null {
  if (firstVisibleKey === null) return null
  const turnIndex = keys.indexOf(firstVisibleKey)
  if (turnIndex < 0) return null
  const rootTop = visibleTop(container) + POSITION_EPSILON
  const row = container.querySelector<HTMLElement>(`[data-turn-key="${CSS.escape(firstVisibleKey)}"]`)

  if (row && row.getBoundingClientRect().top <= rootTop) {
    const bubbles = new Map<string, HTMLElement>()
    for (const bubble of row.querySelectorAll<HTMLElement>(READER_SELECTOR)) bubbles.set(bubble.dataset.readerPrompt!, bubble)
    const firstMounted = firstMountedBlock(row)
    const messages = readerMessages(turns[turnIndex])
    for (let index = messages.length - 1; index >= 0; index--) {
      const { key } = messages[index]
      const bubble = bubbles.get(key)
      // A giant turn mounts only the blocks near the viewport; a prompt in a block before them is above it.
      if (!bubble) {
        if (key !== "prompt" && Number(key) < firstMounted) return { turnIndex, key }
        continue
      }
      const rect = bubble.getBoundingClientRect()
      if (rect.top > rootTop) continue
      return rect.bottom > rootTop ? null : { turnIndex, key }
    }
    // The reader opened this turn and their prompt is just below the top.
    if (messages[0]?.key === "prompt") return null
  }

  // None in this turn starts above the viewport, so it is the last one sent
  // earlier, which the timeline may not have rendered.
  const before = row && row.getBoundingClientRect().top <= rootTop ? turnIndex : turnIndex - 1
  for (let index = Math.min(before, turns.length) - 1; index >= 0; index--) {
    const last = readerMessages(turns[index]).at(-1)
    if (last) return { turnIndex: index, key: last.key }
  }
  return null
}

/** The first content block a windowed turn has mounted; Infinity when it mounts none. */
function firstMountedBlock(row: Element): number {
  let first = Infinity
  for (const item of row.querySelectorAll<HTMLElement>("[data-blocks]")) {
    first = Math.min(first, Number(item.dataset.blocks!.split("-")[0]))
  }
  return first
}

/** Where the viewport starts below the session chrome floating over it, which the scroller's `scroll-padding-top` reserves. */
function visibleTop(container: HTMLElement): number {
  return container.getBoundingClientRect().top + (parseFloat(getComputedStyle(container).scrollPaddingTop) || 0)
}

export const StickyPromptBanner = memo(function StickyPromptBanner({
  session,
  scrollContainerRef,
  timelineRef,
}: StickyPromptBannerProps) {
  const store = useTimelineStore()
  const [sticky, setSticky] = useState<MessageAddress & { sessionId: string } | null>(null)
  const turns = session.turns
  const keys = useMemo(() => turnKeysOf(turns), [turns])
  const latest = useRef({ turns, keys, sessionId: session.sessionId })
  latest.current = { turns, keys, sessionId: session.sessionId }

  const update = useCallback(() => {
    const container = scrollContainerRef.current
    const timeline = timelineRef.current
    if (!container || !timeline) return
    const { turns, keys, sessionId } = latest.current
    const address = scrolledPastMessage(container, turns, keys, timeline.getViewport().firstVisibleKey)
    setSticky((current) => {
      if (address === null) return null
      if (current?.sessionId === sessionId && current.turnIndex === address.turnIndex && current.key === address.key) return current
      return { sessionId, ...address }
    })
  }, [scrollContainerRef, timelineRef])

  // The timeline reports scrolls and range changes; new turns are checked as they land.
  const subscription = useRef<{ handle: TimelineHandle; unsubscribe: () => void } | null>(null)
  useEffect(() => {
    const handle = timelineRef.current
    if (subscription.current?.handle !== handle) {
      subscription.current?.unsubscribe()
      subscription.current = handle ? { handle, unsubscribe: handle.subscribe(update) } : null
    }
    update()
  }, [timelineRef, update, turns, session.sessionId])
  useEffect(() => () => {
    subscription.current?.unsubscribe()
    subscription.current = null
  }, [])

  const message = useMemo(() => {
    if (!sticky || sticky.sessionId !== session.sessionId) return null
    const turn = session.turns[sticky.turnIndex]
    const text = turn && readerMessages(turn).find((candidate) => candidate.key === sticky.key)?.text
    return text ? { ...sticky, text } : null
  }, [session.sessionId, session.turns, sticky])

  if (!message) return null

  const scrollToMessage = () => {
    const turnKey = keys[message.turnIndex]
    if (turnKey === undefined) return
    const selector = `[data-reader-prompt="${CSS.escape(message.key)}"]`
    // A prompt sent mid-turn sits in a content block, which a giant turn may not have mounted.
    const block = message.key === "prompt" ? null : Number(message.key)
    if (store && block !== null) store.set(revealKey(turnKey), block)
    void timelineRef.current?.scrollToTurn(turnKey, { target: (row) => row.querySelector(selector) }).then(() => {
      if (store && block !== null && store.get(revealKey(turnKey)) === block) store.set(revealKey(turnKey), null)
    })
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
