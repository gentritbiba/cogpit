import { createContext, useContext, type ReactNode } from "react"
import { usePtySocket } from "@/hooks/usePtySocket"

type PtyValue = ReturnType<typeof usePtySocket>

const PtyContext = createContext<PtyValue | null>(null)

export function PtyProvider({ children }: { children: ReactNode }): ReactNode {
  const pty = usePtySocket()
  return <PtyContext.Provider value={pty}>{children}</PtyContext.Provider>
}

export function usePty(): PtyValue {
  const ctx = useContext(PtyContext)
  if (!ctx) throw new Error("usePty must be used within a PtyProvider")
  return ctx
}
