import { useState, useRef, useCallback, useEffect, type ReactNode } from "react"

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
  const [isRevealed, setIsRevealed] = useState(false)
  const enterTimer = useRef(0)
  const leaveTimer = useRef(0)

  // When sidebar becomes visible in normal flow, dismiss the overlay
  useEffect(() => {
    if (visible) {
      setIsRevealed(false)
      clearTimeout(enterTimer.current)
      clearTimeout(leaveTimer.current)
    }
  }, [visible])

  // Cleanup timers on unmount
  useEffect(() => () => {
    clearTimeout(enterTimer.current)
    clearTimeout(leaveTimer.current)
  }, [])

  // Shared enter/leave handlers used by both the trigger zone and the overlay.
  // When the mouse transitions from trigger → overlay (or vice-versa), the
  // leave timer from one element is cancelled by the enter of the other.
  const handleEnter = useCallback(() => {
    clearTimeout(leaveTimer.current)
    clearTimeout(enterTimer.current)
    enterTimer.current = window.setTimeout(() => setIsRevealed(true), 200)
  }, [])

  const handleLeave = useCallback(() => {
    clearTimeout(enterTimer.current)
    leaveTimer.current = window.setTimeout(() => setIsRevealed(false), 300)
  }, [])

  // When visible in normal flow, just render children directly
  if (visible) return <>{children}</>

  // When not enabled (e.g. no session for right sidebar, config view), render nothing
  if (!enabled) return null

  return (
    <>
      {/* Thin trigger zone at the window edge — in flex flow */}
      <div
        className="shrink-0 group relative z-10"
        style={{ width: 6 }}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        <div
          className={`w-[2px] h-full mx-auto opacity-0 group-hover:opacity-100 bg-blue-500/40 transition-opacity duration-150`}
        />
      </div>

      {/* Overlay sidebar — absolutely positioned, does not displace content */}
      {isRevealed && (
        <div
          className={`absolute top-0 bottom-0 z-40 ${
            side === "left" ? "left-0" : "right-0"
          }`}
          style={{
            boxShadow:
              side === "left"
                ? "4px 0 24px rgba(0,0,0,0.35)"
                : "-4px 0 24px rgba(0,0,0,0.35)",
          }}
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
        >
          {children}
        </div>
      )}
    </>
  )
}
