import { useState, useEffect, useRef, useMemo, useCallback, memo } from "react"
import { User, ChevronUp } from "lucide-react"
import type { ParsedSession } from "@/lib/types"
import { getUserMessageText } from "@/lib/parser"
import { cn } from "@/lib/utils"

const SYSTEM_TAG_RE =
  /<(?:system-reminder|local-command-caveat|command-name|teammate-message|env|claude_background_info|fast_mode_info|gitStatus)[^>]*>[\s\S]*?<\/(?:system-reminder|local-command-caveat|command-name|teammate-message|env|claude_background_info|fast_mode_info|gitStatus)>/g

interface StickyPromptBannerProps {
  session: ParsedSession
  scrollContainerRef: React.RefObject<HTMLElement | null>
}

export const StickyPromptBanner = memo(function StickyPromptBanner({
  session,
  scrollContainerRef,
}: StickyPromptBannerProps) {
  const [stickyTurn, setStickyTurn] = useState<{
    index: number
    userMsgVisible: boolean
  } | null>(null)

  // Track visible turn elements via IntersectionObserver (no synchronous layout reads)
  const visibleTurnsRef = useRef(new Map<number, IntersectionObserverEntry>())
  const observerRef = useRef<IntersectionObserver | null>(null)
  const mutationObserverRef = useRef<MutationObserver | null>(null)

  const computeStickyTurn = useCallback(() => {
    const visible = visibleTurnsRef.current
    if (visible.size === 0) {
      setStickyTurn(null)
      return
    }

    // Find the topmost visible turn (smallest intersectionRect.top or largest negative boundingClientRect.top)
    let bestIndex: number | null = null
    let bestTop = Infinity

    for (const [index, entry] of visible) {
      // The turn that is closest to the top of the viewport and still intersecting
      if (entry.boundingClientRect.top < bestTop) {
        bestTop = entry.boundingClientRect.top
        bestIndex = index
      }
    }

    if (bestIndex === null) {
      setStickyTurn(null)
      return
    }

    // User message is considered visible if the top of the turn is within 120px of the container top
    const entry = visible.get(bestIndex)!
    const rootTop = entry.rootBounds?.top ?? 0
    const userMsgVisible = entry.boundingClientRect.top + 120 > rootTop

    setStickyTurn({ index: bestIndex, userMsgVisible })
  }, [])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    // Create IntersectionObserver rooted in the scroll container
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement
          const index = parseInt(el.dataset.turnIndex!, 10)
          if (entry.isIntersecting) {
            visibleTurnsRef.current.set(index, entry)
          } else {
            visibleTurnsRef.current.delete(index)
          }
        }
        computeStickyTurn()
      },
      {
        root: container,
        // Use a top margin to detect turns near the top edge
        rootMargin: "0px 0px 0px 0px",
        threshold: [0, 0.1],
      }
    )
    observerRef.current = observer

    // Observe all existing turn elements
    const turnEls = container.querySelectorAll<HTMLElement>("[data-turn-index]")
    for (const el of turnEls) observer.observe(el)

    // Watch for new turn elements being added (live sessions, virtualized lists)
    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            if (node.dataset.turnIndex !== undefined) {
              observer.observe(node)
            }
            // Also check children
            const children = node.querySelectorAll<HTMLElement>("[data-turn-index]")
            for (const child of children) observer.observe(child)
          }
        }
      }
    })
    mutationObserver.observe(container, { childList: true, subtree: true })
    mutationObserverRef.current = mutationObserver

    const visibleTurns = visibleTurnsRef.current
    return () => {
      observer.disconnect()
      mutationObserver.disconnect()
      visibleTurns.clear()
      observerRef.current = null
      mutationObserverRef.current = null
    }
  }, [scrollContainerRef, computeStickyTurn])

  const stickyTurnIndex = stickyTurn?.index ?? null
  const promptText = useMemo(() => {
    if (stickyTurnIndex === null || !stickyTurn) return null
    const turn = session.turns[stickyTurnIndex]
    if (!turn?.userMessage) return null
    const raw = getUserMessageText(turn.userMessage)
    const clean = raw.replace(SYSTEM_TAG_RE, "").trim()
    if (!clean) return null
    const firstLine = clean.split("\n")[0]
    return firstLine.length > 150 ? firstLine.slice(0, 150) + "..." : firstLine
  }, [stickyTurnIndex, stickyTurn, session.turns])

  const scrollToPrompt = () => {
    const container = scrollContainerRef.current
    if (!container || !stickyTurn) return
    const turnEl = container.querySelector<HTMLElement>(
      `[data-turn-index="${stickyTurn.index}"]`
    )
    if (turnEl) {
      turnEl.scrollIntoView({ behavior: "smooth", block: "start" })
    }
  }

  if (!promptText || !stickyTurn || stickyTurn.userMsgVisible) return null

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Scroll to turn ${stickyTurn.index + 1} prompt`}
      className={cn(
        "absolute inset-x-0 top-0 z-20",
        "border-b border-blue-500/10 bg-elevation-1",
        "px-4 py-2.5 flex items-center gap-3 cursor-pointer",
        "transition-colors duration-200 hover:bg-elevation-2"
      )}
      onClick={scrollToPrompt}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") scrollToPrompt() }}
    >
      <div className="flex-shrink-0">
        <div className="w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center">
          <User className="w-3.5 h-3.5 text-blue-400" />
        </div>
      </div>
      <span className="text-xs font-medium text-blue-400/70 shrink-0">
        Turn {stickyTurn.index + 1}
      </span>
      <span className="text-sm text-muted-foreground truncate min-w-0">
        {promptText}
      </span>
      <ChevronUp className="size-3.5 text-muted-foreground shrink-0 ml-auto" />
    </div>
  )
})
