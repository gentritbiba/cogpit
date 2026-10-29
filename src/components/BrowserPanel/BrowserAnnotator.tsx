import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { CONTEXT_LIMITS, newContextId, type BrowserContext, type ComposerAttachment } from "../../../shared/session/composerContext"
import { fitRect, toDevicePoint, type DevicePoint } from "./pointerMath"

/** A frame copied out of the screencast when annotation began, with where it came from. */
export interface FrozenFrame {
  /** The frame at its own resolution; it no longer depends on the live bitmap. */
  canvas: HTMLCanvasElement
  /** The page's CSS pixel size the frame shows. */
  deviceWidth: number
  deviceHeight: number
  url: string
  title: string
  browser: string
  tab?: string
  capturedAt: string
}

/** Copies the frame on screen now, before the socket replaces and closes its bitmap. Null when it is already gone. */
export function freezeFrame(bitmap: ImageBitmap, page: Omit<FrozenFrame, "canvas">): FrozenFrame | null {
  try {
    const canvas = document.createElement("canvas")
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext("2d")
    if (!context || canvas.width === 0) return null
    context.drawImage(bitmap, 0, 0)
    return { ...page, canvas }
  } catch {
    return null
  }
}

type Region = BrowserContext["region"]

/** The image of `region` (page CSS pixels), scaled down to fit the attachment bounds. */
export function cropRegion(frame: FrozenFrame, region: Region, maxDimension = 1568): ComposerAttachment {
  const scale = frame.canvas.width / frame.deviceWidth
  const source = { x: region.x * scale, y: region.y * scale, width: Math.max(1, region.width * scale), height: Math.max(1, region.height * scale) }
  const shrink = Math.min(1, maxDimension / Math.max(source.width, source.height))
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(source.width * shrink))
  canvas.height = Math.max(1, Math.round(source.height * shrink))
  canvas.getContext("2d")?.drawImage(frame.canvas, source.x, source.y, source.width, source.height, 0, 0, canvas.width, canvas.height)
  return { id: crypto.randomUUID(), mediaType: "image/jpeg", data: canvas.toDataURL("image/jpeg", 0.85).split(",")[1] ?? "" }
}

function regionBetween(a: DevicePoint, b: DevicePoint): Region {
  return { x: Math.round(Math.min(a.x, b.x)), y: Math.round(Math.min(a.y, b.y)), width: Math.round(Math.abs(a.x - b.x)), height: Math.round(Math.abs(a.y - b.y)) }
}

/**
 * Annotation over a frozen frame: drag a rectangle (the whole page until one
 * is drawn), write a note, and add both to the message with the region's
 * saved image. The live page sees none of these pointer events — the
 * viewport is not mounted while this is.
 */
export function BrowserAnnotator({
  frame,
  onAdd,
  onCancel,
}: {
  frame: FrozenFrame
  onAdd: (item: BrowserContext, image: ComposerAttachment) => string | null
  onCancel: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const whole: Region = useMemo(() => ({ x: 0, y: 0, width: frame.deviceWidth, height: frame.deviceHeight }), [frame])
  const [region, setRegion] = useState<Region>(whole)
  const [drag, setDrag] = useState<DevicePoint | null>(null)
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)
  const fit = useMemo(() => fitRect(size, { width: frame.deviceWidth, height: frame.deviceHeight }), [size, frame])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || fit.width <= 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size.width * dpr)
    canvas.height = Math.round(size.height * dpr)
    const context = canvas.getContext("2d")
    if (!context) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, size.width, size.height)
    context.drawImage(frame.canvas, fit.x, fit.y, fit.width, fit.height)
  }, [frame, fit, size])

  const pointAt = (event: ReactPointerEvent) => {
    const canvas = canvasRef.current
    return canvas ? toDevicePoint(event.clientX, event.clientY, canvas.getBoundingClientRect(), fit, { clamp: true }) : null
  }

  function add() {
    if (region.width < 4 || region.height < 4) {
      setError("Mark a larger region, or use the whole page")
      return
    }
    const item: BrowserContext = {
      id: newContextId(),
      kind: "browser",
      note: note.trim().slice(0, CONTEXT_LIMITS.noteChars),
      url: frame.url,
      title: frame.title,
      viewport: { width: frame.deviceWidth, height: frame.deviceHeight },
      region,
      capturedAt: frame.capturedAt,
      browser: frame.browser,
      ...(frame.tab ? { tab: frame.tab } : {}),
      image: 1,
    }
    const refusal = onAdd(item, cropRegion(frame, region))
    if (refusal) setError(refusal)
    else onCancel()
  }

  const box = {
    left: fit.x + region.x * fit.scale,
    top: fit.y + region.y * fit.scale,
    width: region.width * fit.scale,
    height: region.height * fit.scale,
  }
  const isWhole = region.x === 0 && region.y === 0 && region.width === frame.deviceWidth && region.height === frame.deviceHeight

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onCancel() } }}>
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden bg-muted/30">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Frozen frame of ${frame.title || frame.url}. Drag to mark a region; the page does not receive these clicks.`}
          className="block size-full cursor-crosshair touch-none select-none"
          style={{ width: size.width, height: size.height }}
          onPointerDown={(event) => {
            const point = pointAt(event)
            if (!point) return
            event.currentTarget.setPointerCapture(event.pointerId)
            setDrag(point)
            setRegion({ x: Math.round(point.x), y: Math.round(point.y), width: 0, height: 0 })
          }}
          onPointerMove={(event) => {
            const point = drag && pointAt(event)
            if (drag && point) setRegion(regionBetween(drag, point))
          }}
          onPointerUp={(event) => {
            const point = drag && pointAt(event)
            if (drag && point) setRegion(regionBetween(drag, point))
            setDrag(null)
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
          }}
        />
        {!isWhole && <div aria-hidden className="pointer-events-none absolute border-2 border-info bg-info/10" style={box} />}
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-t p-2">
        <p className="text-xs text-muted-foreground" role="status">
          {isWhole ? "Whole page selected. Drag on the frame to mark a region." : `Region ${region.width}×${region.height} at ${region.x},${region.y}`}
        </p>
        <Textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="What should the agent look at here?"
          aria-label="Annotation note"
          rows={2}
          maxLength={CONTEXT_LIMITS.noteChars}
          className="min-h-0 resize-none text-sm"
          autoFocus
        />
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!isWhole && <Button type="button" variant="ghost" size="sm" onClick={() => setRegion(whole)}>Use whole page</Button>}
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button type="button" size="sm" onClick={add}>Add to message</Button>
        </div>
      </div>
    </div>
  )
}
