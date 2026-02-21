import { useState, useEffect, useRef, useMemo, memo } from "react"
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
  const rafRef = useRef(0)

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    const update = () => {
      const containerTop = container.getBoundingClientRect().top
      const probe = containerTop + 80
      const turnEls = container.querySelectorAll<HTMLElement>("[data-turn-index]")

      let bestIndex: number | null = null
      let bestTop = -Infinity

      for (const el of turnEls) {
        const rect = el.getBoundingClientRect()
        // Find the turn that spans across our probe point
        if (rect.top <= probe && rect.bottom > probe && rect.top > bestTop) {
          bestIndex = parseInt(el.dataset.turnIndex!, 10)
          bestTop = rect.top
        }
      }

      if (bestIndex === null) {
        setStickyTurn(null)
        return
      }

      // Check if the user message area (first ~120px of the turn) is still visible
      const turnEl = container.querySelector<HTMLElement>(
        `[data-turn-index="${bestIndex}"]`
      )
      if (!turnEl) {
        setStickyTurn(null)
        return
      }

      const turnTop = turnEl.getBoundingClientRect().top
      const userMsgVisible = turnTop + 120 > containerTop

      setStickyTurn({ index: bestIndex, userMsgVisible })
    }

    const handleScroll = () => {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(update)
    }

    container.addEventListener("scroll", handleScroll, { passive: true })
    update()

    return () => {
      container.removeEventListener("scroll", handleScroll)
      cancelAnimationFrame(rafRef.current)
    }
  }, [scrollContainerRef])

  const promptText = useMemo(() => {
    if (!stickyTurn) return null
    const turn = session.turns[stickyTurn.index]
    if (!turn?.userMessage) return null
    const raw = getUserMessageText(turn.userMessage)
    const clean = raw.replace(SYSTEM_TAG_RE, "").trim()
    if (!clean) return null
    const firstLine = clean.split("\n")[0]
    return firstLine.length > 150 ? firstLine.slice(0, 150) + "..." : firstLine
  }, [stickyTurn?.index, session.turns])

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
        "border-b border-blue-500/10 bg-elevation-1/90 backdrop-blur-md",
        "px-4 py-2.5 flex items-center gap-3 cursor-pointer",
        "transition-all duration-200 hover:bg-elevation-1"
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
