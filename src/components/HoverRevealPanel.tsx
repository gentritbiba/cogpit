import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useId,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface HoverRevealPanelProps {
  side: "left" | "right"
  children: ReactNode
  /** When true, sidebar renders in normal document flow (no hover behavior) */
  visible: boolean
  /** Whether hover-reveal is enabled when sidebar is hidden */
  enabled?: boolean
}

const EXIT_ANIMATION_MS = 150
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== "function") return false

  try {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches
  } catch {
    return false
  }
}

/**
 * Wraps a sidebar so that when toggled off it can be temporarily revealed
 * by hovering near the window edge. The sidebar appears as an absolute overlay
 * without displacing the main content.
 */
export function HoverRevealPanel({
  side,
  children,
  visible,
  enabled = true,
}: HoverRevealPanelProps) {
  if (visible) return <>{children}</>
  if (!enabled) return null

  return <HoverRevealOverlay side={side}>{children}</HoverRevealOverlay>
}

function HoverRevealOverlay({
  side,
  children,
}: Pick<HoverRevealPanelProps, "side" | "children">) {
  const [isRevealed, setIsRevealed] = useState(false)
  const [isPresent, setIsPresent] = useState(false)
  const enterTimer = useRef(0)
  const leaveTimer = useRef(0)
  const exitTimer = useRef(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const suppressNextTriggerFocus = useRef(false)
  const panelId = useId()

  // Cleanup timers on unmount
  useEffect(() => () => {
    clearTimeout(enterTimer.current)
    clearTimeout(leaveTimer.current)
    clearTimeout(exitTimer.current)
  }, [])

  const revealOverlay = useCallback(() => {
    clearTimeout(exitTimer.current)
    setIsPresent(true)
    setIsRevealed(true)
  }, [])

  const hideOverlay = useCallback(() => {
    clearTimeout(exitTimer.current)
    setIsRevealed(false)

    if (prefersReducedMotion()) {
      setIsPresent(false)
      return
    }

    exitTimer.current = window.setTimeout(() => {
      exitTimer.current = 0
      setIsPresent(false)
    }, EXIT_ANIMATION_MS)
  }, [])

  const handleEnter = useCallback(() => {
    clearTimeout(leaveTimer.current)
    clearTimeout(enterTimer.current)
    enterTimer.current = window.setTimeout(revealOverlay, 200)
  }, [revealOverlay])

  const handleFocusEnter = useCallback(() => {
    clearTimeout(leaveTimer.current)
    clearTimeout(enterTimer.current)
    revealOverlay()
  }, [revealOverlay])

  const handleTriggerFocus = useCallback(() => {
    if (suppressNextTriggerFocus.current) {
      suppressNextTriggerFocus.current = false
      return
    }
    handleFocusEnter()
  }, [handleFocusEnter])

  const handleLeave = useCallback(() => {
    clearTimeout(enterTimer.current)
    leaveTimer.current = window.setTimeout(hideOverlay, 300)
  }, [hideOverlay])

  const handleMouseLeave = useCallback(() => {
    const focused = document.activeElement
    if (triggerRef.current?.contains(focused) || overlayRef.current?.contains(focused)) return
    handleLeave()
  }, [handleLeave])

  const handleFocusLeave = useCallback((event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget
    if (triggerRef.current?.contains(next) || overlayRef.current?.contains(next)) return
    handleLeave()
  }, [handleLeave])

  const handleOverlayKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return
    event.preventDefault()
    clearTimeout(enterTimer.current)
    clearTimeout(leaveTimer.current)
    hideOverlay()
    suppressNextTriggerFocus.current = true
    requestAnimationFrame(() => triggerRef.current?.focus())
  }, [hideOverlay])

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        aria-label={`Reveal ${side} sidebar`}
        aria-controls={panelId}
        aria-expanded={isRevealed}
        title={`Reveal ${side} sidebar`}
        className="group relative z-10 h-auto w-1.5 shrink-0 rounded-none p-0 focus-visible:ring-inset"
        onMouseEnter={handleEnter}
        onMouseLeave={handleMouseLeave}
        onFocus={handleTriggerFocus}
        onBlur={handleFocusLeave}
        onClick={handleFocusEnter}
      >
        <span
          aria-hidden="true"
          className="mx-auto h-full w-px bg-border opacity-0 transition-opacity duration-150 group-hover:opacity-100"
        />
      </Button>

      {isPresent && (
        <div
          ref={overlayRef}
          id={panelId}
          aria-hidden={!isRevealed}
          inert={!isRevealed}
          className={cn(
            "electron-no-drag absolute inset-y-0 z-40 bg-background shadow-sm",
            !isRevealed && "pointer-events-none animate-out fade-out-0 fill-mode-forwards duration-150 ease-in",
            side === "left"
              ? isRevealed
                ? "left-0 border-r panel-enter"
                : "left-0 border-r slide-out-to-left-3"
              : isRevealed
                ? "right-0 border-l panel-enter-right"
                : "right-0 border-l slide-out-to-right-3",
          )}
          onMouseEnter={handleEnter}
          onMouseLeave={handleMouseLeave}
          onFocusCapture={handleFocusEnter}
          onBlurCapture={handleFocusLeave}
          onKeyDown={handleOverlayKeyDown}
        >
          {children}
        </div>
      )}
    </>
  )
}
