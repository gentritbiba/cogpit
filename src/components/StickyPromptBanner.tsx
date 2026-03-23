import { useState, useEffect, useRef, useMemo, useCallback, memo } from "react"
import { ChevronUp, ChevronDown } from "lucide-react"
import type { ParsedSession } from "@/lib/types"
import { getUserMessageText } from "@/lib/parser"
import { useAppContext } from "@/contexts/AppContext"
import { cn } from "@/lib/utils"

const SYSTEM_TAG_RE =
  /<(?:system-reminder|local-command-caveat|command-name|teammate-message|env|claude_background_info|fast_mode_info|gitStatus)[^>]*>[\s\S]*?<\/(?:system-reminder|local-command-caveat|command-name|teammate-message|env|claude_background_info|fast_mode_info|gitStatus)>/g

/** Extract a clean, truncated prompt preview from a turn. */
function getTurnPrompt(session: ParsedSession, index: number, maxLen = 120): string {
  const turn = session.turns[index]
  if (!turn?.userMessage) return "(no prompt)"
  const raw = getUserMessageText(turn.userMessage)
  const clean = raw.replace(SYSTEM_TAG_RE, "").trim()
  if (!clean) return "(no prompt)"
  const firstLine = clean.split("\n")[0]
  return firstLine.length > maxLen ? firstLine.slice(0, maxLen) + "..." : firstLine
}

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
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Track visible turn elements via IntersectionObserver
  const visibleTurnsRef = useRef(new Map<number, IntersectionObserverEntry>())
  const observerRef = useRef<IntersectionObserver | null>(null)
  const mutationObserverRef = useRef<MutationObserver | null>(null)

  const computeStickyTurn = useCallback(() => {
    const visible = visibleTurnsRef.current
    if (visible.size === 0) {
      setStickyTurn(null)
      return
    }

    let bestIndex: number | null = null
    let bestTop = Infinity

    for (const [index, entry] of visible) {
      if (entry.boundingClientRect.top < bestTop) {
        bestTop = entry.boundingClientRect.top
        bestIndex = index
      }
    }

    if (bestIndex === null) {
      setStickyTurn(null)
      return
    }

    const entry = visible.get(bestIndex)!
    const rootTop = entry.rootBounds?.top ?? 0
    const userMsgVisible = entry.boundingClientRect.top + 120 > rootTop

    setStickyTurn({ index: bestIndex, userMsgVisible })
  }, [])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

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
        rootMargin: "0px 0px 0px 0px",
        threshold: [0, 0.1],
      }
    )
    observerRef.current = observer

    const turnEls = container.querySelectorAll<HTMLElement>("[data-turn-index]")
    for (const el of turnEls) observer.observe(el)

    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            if (node.dataset.turnIndex !== undefined) {
              observer.observe(node)
            }
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

  const promptText = useMemo(() => {
    if (!stickyTurn) return null
    return getTurnPrompt(session, stickyTurn.index, 150)
  }, [stickyTurn, session])

  // All turn previews for the dropdown
  const turnPreviews = useMemo(() => {
    return session.turns.map((_, i) => ({
      index: i,
      prompt: getTurnPrompt(session, i, 80),
    }))
  }, [session])

  const { dispatch } = useAppContext()
  const totalTurns = session.turns.length

  const jumpToTurn = useCallback((index: number) => {
    dispatch({ type: "JUMP_TO_TURN", index })
    setDropdownOpen(false)
  }, [dispatch])

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [dropdownOpen])

  // Close dropdown on Escape
  useEffect(() => {
    if (!dropdownOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDropdownOpen(false)
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [dropdownOpen])

  // Close dropdown when sticky turn changes (user scrolled)
  useEffect(() => {
    setDropdownOpen(false)
  }, [stickyTurn?.index])

  if (!promptText || !stickyTurn || stickyTurn.userMsgVisible) return null

  return (
    <div ref={dropdownRef} className="absolute inset-x-0 top-0 z-20">
      {/* Banner */}
      <button
        className={cn(
          "w-full bg-blue-950 border-b border-blue-500/20",
          "px-3 py-1.5 flex items-center gap-2",
          "cursor-pointer hover:bg-blue-900/80 transition-colors"
        )}
        onClick={() => setDropdownOpen(!dropdownOpen)}
        aria-label="Open turn list"
      >
        <span className="text-[11px] font-medium text-blue-400/80 shrink-0">
          Turn {stickyTurn.index + 1}/{totalTurns}
        </span>
        <span className="text-xs text-blue-100/70 truncate min-w-0 text-left">
          {promptText}
        </span>
        {dropdownOpen ? (
          <ChevronUp className="size-3 text-blue-400/60 shrink-0 ml-auto" />
        ) : (
          <ChevronDown className="size-3 text-blue-400/60 shrink-0 ml-auto" />
        )}
      </button>

      {/* Turn jumplist dropdown */}
      {dropdownOpen && (
        <div className="bg-elevation-1 border border-border/50 shadow-xl max-h-[50vh] overflow-y-auto">
          {turnPreviews.map(({ index, prompt }) => (
            <button
              key={index}
              onClick={() => jumpToTurn(index)}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-elevation-2 transition-colors",
                index === stickyTurn.index && "bg-blue-500/10",
              )}
            >
              <span className={cn(
                "text-[10px] font-mono font-medium shrink-0 w-6 text-right tabular-nums",
                index === stickyTurn.index ? "text-blue-400" : "text-muted-foreground/60",
              )}>
                {index + 1}
              </span>
              <span className={cn(
                "text-[11px] truncate",
                index === stickyTurn.index ? "text-blue-100" : "text-muted-foreground",
              )}>
                {prompt}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
})
