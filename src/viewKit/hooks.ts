/** `cogpit/ui` hooks onto the frame kit's `window.cogpit`. */
import { useEffect, useRef, useState } from "react"
import type { ViewTheme } from "../../shared/views/frame"
import { frameApi } from "./frameApi"

/** Puts `text` in the user's composer to send; works only from a click in the view. */
export function ask(text: string): void {
  frameApi()?.ask(text)
}

/** A theme color (`"--chart-1"`) as a value canvas, SVG attributes and libraries accept. */
export function themeColor(name: string): string {
  return frameApi()?.color(name) ?? ""
}

/** The theme, re-rendering when the user switches light and dark. */
export function useTheme(): { mode: ViewTheme["mode"]; color: (name: string) => string } {
  const [mode, setMode] = useState<ViewTheme["mode"]>(() => frameApi()?.theme.mode ?? "light")
  useEffect(() => frameApi()?.onTheme((theme) => setMode(theme.mode)), [])
  return { mode, color: themeColor }
}

/** Calls `step` each frame with the milliseconds since the last one, while `running`. */
export function useAnimationFrame(step: (elapsedMs: number) => void, running = true): void {
  const latest = useRef(step)
  useEffect(() => { latest.current = step })
  useEffect(() => {
    if (!running) return
    let handle = 0
    let last = performance.now()
    const tick = (now: number) => {
      latest.current(now - last)
      last = now
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [running])
}
