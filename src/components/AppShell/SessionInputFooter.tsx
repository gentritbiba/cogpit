import type { ReactNode } from "react"

interface SessionInputFooterProps {
  floating?: boolean
  children: ReactNode
}

/** Keeps the session composer aligned across pending and active sessions. */
export function SessionInputFooter({ floating, children }: SessionInputFooterProps) {
  if (floating) {
    return (
      <div className="absolute bottom-0 left-0 right-0 z-20 flex justify-center pointer-events-none">
        <div className="w-full max-w-3xl px-3 pt-6 bg-gradient-to-t from-elevation-1 from-80% to-transparent pointer-events-auto">
          {children}
        </div>
      </div>
    )
  }

  return (
    <div className="w-full flex justify-center shrink-0">
      <div className="w-full max-w-3xl px-3">
        {children}
      </div>
    </div>
  )
}
