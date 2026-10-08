import { useLayoutEffect, useRef, type ReactNode } from "react"

interface SessionInputFooterProps {
  floating?: boolean
  children: ReactNode
}

/** Keeps the session composer aligned across pending and active sessions. */
export function SessionInputFooter({ floating, children }: SessionInputFooterProps) {
  const footerRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const footer = footerRef.current
    const container = footer?.parentElement
    if (!floating || !footer || !container) return
    const previous = container.style.getPropertyValue("--session-footer-height")
    const measure = () => container.style.setProperty("--session-footer-height", `${footer.getBoundingClientRect().height}px`)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(footer)
    return () => {
      observer.disconnect()
      if (previous) container.style.setProperty("--session-footer-height", previous)
      else container.style.removeProperty("--session-footer-height")
    }
  }, [floating])
  if (floating) {
    return (
      <div ref={footerRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center bg-gradient-to-t from-canvas via-canvas/70 to-transparent pt-4">
        <div className="pointer-events-auto w-full max-w-[var(--chat-width)] px-3 pb-3">
          {children}
        </div>
      </div>
    )
  }

  return (
    <div className="flex w-full shrink-0 justify-center">
      <div className="w-full max-w-[var(--chat-width)] px-3 pb-3">
        {children}
      </div>
    </div>
  )
}
