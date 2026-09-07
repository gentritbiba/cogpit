import type { ReactNode } from "react"

interface SessionInputFooterProps {
  floating?: boolean
  children: ReactNode
}

/** Keeps the session composer aligned across pending and active sessions. */
export function SessionInputFooter({ floating, children }: SessionInputFooterProps) {
  if (floating) {
    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center bg-gradient-to-t from-background via-background/70 to-transparent pt-4">
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
