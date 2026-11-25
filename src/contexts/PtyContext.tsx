import { createContext, useContext, type ReactNode } from "react"
import { usePtySocket } from "@/hooks/usePtySocket"

type PtyValue = ReturnType<typeof usePtySocket>

const PtyContext = createContext<PtyValue | null>(null)

export function PtyProvider({ children, enabled = true }: { children: ReactNode; enabled?: boolean }): ReactNode {
  const pty = usePtySocket(enabled)
  return <PtyContext.Provider value={pty}>{children}</PtyContext.Provider>
}

/** The terminal socket, or null outside a provider: a guest's shared view has none. */
export function useOptionalPty(): PtyValue | null {
  return useContext(PtyContext)
}

export function usePty(): PtyValue {
  const ctx = useContext(PtyContext)
  if (!ctx) throw new Error("usePty must be used within a PtyProvider")
  return ctx
}
