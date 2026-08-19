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
  const enterTimer = useRef(0)
  const leaveTimer = useRef(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const suppressNextTriggerFocus = useRef(false)
  const panelId = useId()

  // Cleanup timers on unmount
  useEffect(() => () => {
    clearTimeout(enterTimer.current)
    clearTimeout(leaveTimer.current)
  }, [])

  const handleEnter = useCallback(() => {
    clearTimeout(leaveTimer.current)
    clearTimeout(enterTimer.current)
    enterTimer.current = window.setTimeout(() => setIsRevealed(true), 200)
  }, [])

  const handleFocusEnter = useCallback(() => {
    clearTimeout(leaveTimer.current)
    clearTimeout(enterTimer.current)
    setIsRevealed(true)
  }, [])

  const handleTriggerFocus = useCallback(() => {
    if (suppressNextTriggerFocus.current) {
      suppressNextTriggerFocus.current = false
      return
    }
    handleFocusEnter()
  }, [handleFocusEnter])

  const handleLeave = useCallback(() => {
    clearTimeout(enterTimer.current)
    leaveTimer.current = window.setTimeout(() => setIsRevealed(false), 300)
  }, [])

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
    setIsRevealed(false)
    suppressNextTriggerFocus.current = true
    requestAnimationFrame(() => triggerRef.current?.focus())
  }, [])

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

      {isRevealed && (
        <div
          ref={overlayRef}
          id={panelId}
          className={cn(
            "absolute inset-y-0 z-40 bg-background shadow-sm",
            side === "left" ? "left-0 border-r" : "right-0 border-l",
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
