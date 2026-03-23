import { createContext, useContext, useState, useCallback, type ReactNode } from "react"

const STORAGE_KEY = "cogpit:diff-font-size"
const DEFAULT_SIZE = 12
const MIN_SIZE = 9
const MAX_SIZE = 20
const STEP = 1

function loadSize(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const n = Number(raw)
      if (n >= MIN_SIZE && n <= MAX_SIZE) return n
    }
  } catch { /* ignore */ }
  return DEFAULT_SIZE
}

interface DiffFontSizeContextValue {
  fontSize: number
  increase: () => void
  decrease: () => void
}

const DiffFontSizeContext = createContext<DiffFontSizeContextValue>({
  fontSize: DEFAULT_SIZE,
  increase: () => {},
  decrease: () => {},
})

export function DiffFontSizeProvider({ children }: { children: ReactNode }) {
  const [fontSize, setFontSize] = useState(loadSize)

  const increase = useCallback(() => {
    setFontSize((prev) => {
      const next = Math.min(prev + STEP, MAX_SIZE)
      localStorage.setItem(STORAGE_KEY, String(next))
      return next
    })
  }, [])

  const decrease = useCallback(() => {
    setFontSize((prev) => {
      const next = Math.max(prev - STEP, MIN_SIZE)
      localStorage.setItem(STORAGE_KEY, String(next))
      return next
    })
  }, [])

  return (
    <DiffFontSizeContext.Provider value={{ fontSize, increase, decrease }}>
      {children}
    </DiffFontSizeContext.Provider>
  )
}

export function useDiffFontSize() {
  return useContext(DiffFontSizeContext)
}
