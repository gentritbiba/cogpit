import { useEffect, useRef } from "react"
import { cn } from "@/lib/utils"

const PITCH = 4
const ROW = 3.5
const DOT = 1
const HALF_ROWS = 3
const STEP_MS = 70

/** A scrolling dot-matrix level meter: one column per step, taller for louder input, a single dot for silence. */
export function DictationWaveform({ level, className }: { level: () => number; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const element = canvas.current
    const draw = element?.getContext("2d")
    if (!element || !draw) return
    const width = element.clientWidth, height = element.clientHeight, ratio = window.devicePixelRatio || 1
    element.width = Math.round(width * ratio)
    element.height = Math.round(height * ratio)
    draw.scale(ratio, ratio)
    const history = new Array<number>(Math.max(1, Math.floor(width / PITCH))).fill(0)
    let peak = 0, last = -Infinity, frame = 0
    const render = (now: number) => {
      peak = Math.max(peak, level())
      if (now - last >= STEP_MS) {
        history.shift(); history.push(peak)
        peak = 0; last = now
        draw.clearRect(0, 0, width, height)
        draw.fillStyle = getComputedStyle(element).color
        history.forEach((value, column) => {
          const reach = Math.round(value * HALF_ROWS)
          for (let row = -reach; row <= reach; row++) {
            draw.beginPath()
            draw.arc(column * PITCH + PITCH / 2, height / 2 + row * ROW, DOT, 0, Math.PI * 2)
            draw.fill()
          }
        })
      }
      frame = requestAnimationFrame(render)
    }
    frame = requestAnimationFrame(render)
    return () => cancelAnimationFrame(frame)
  }, [level])
  return <canvas ref={canvas} aria-hidden className={cn("h-6 w-28 text-muted-foreground", className)} />
}
