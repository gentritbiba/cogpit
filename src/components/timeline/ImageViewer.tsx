import { useCallback, useRef, useState } from "react"
import {
  ChevronLeft,
  ChevronRight,
  ImageIcon,
  Maximize2,
  Minus,
  Plus,
  X,
} from "lucide-react"
import {
  TransformComponent,
  TransformWrapper,
  type ReactZoomPanPinchRef,
} from "react-zoom-pan-pinch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

export interface ImageViewerItem {
  id: string
  src: string
  alt: string
  label?: string
}

interface ImageViewerProps {
  images: ImageViewerItem[]
  initialIndex: number
  onClose: () => void
}

const MAX_ZOOM = 8
const SWIPE_THRESHOLD = 56

function IconButton({
  label,
  disabled,
  onClick,
  children,
  className,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
  className?: string
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.06] text-white/75 transition-colors",
        "hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70",
        "disabled:pointer-events-none disabled:opacity-30",
        className,
      )}
    >
      {children}
    </button>
  )
}

export function ImageViewer({ images, initialIndex, onClose }: ImageViewerProps): React.ReactElement | null {
  const safeInitialIndex = Math.min(Math.max(initialIndex, 0), Math.max(images.length - 1, 0))
  const [index, setIndex] = useState(safeInitialIndex)
  const [zoomPercent, setZoomPercent] = useState(100)
  const transformRef = useRef<ReactZoomPanPinchRef | null>(null)
  const pointerStart = useRef<{ x: number; y: number } | null>(null)
  const current = images[index]

  const goTo = useCallback((nextIndex: number) => {
    setIndex(Math.min(Math.max(nextIndex, 0), images.length - 1))
    setZoomPercent(100)
  }, [images.length])

  const goPrev = useCallback(() => goTo(index - 1), [goTo, index])
  const goNext = useCallback(() => goTo(index + 1), [goTo, index])

  if (!current) return null

  const hasMultiple = images.length > 1
  const canGoPrev = index > 0
  const canGoNext = index < images.length - 1
  const isZoomedIn = zoomPercent > 100

  const zoomIn = () => transformRef.current?.zoomIn()
  const zoomOut = () => transformRef.current?.zoomOut()
  const resetZoom = () => transformRef.current?.resetTransform()

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowLeft" && canGoPrev) {
      event.preventDefault()
      goPrev()
    } else if (event.key === "ArrowRight" && canGoNext) {
      event.preventDefault()
      goNext()
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault()
      zoomIn()
    } else if (event.key === "-") {
      event.preventDefault()
      zoomOut()
    } else if (event.key === "0") {
      event.preventDefault()
      resetZoom()
    }
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" || event.isPrimary === false) {
      pointerStart.current = null
      return
    }
    pointerStart.current = { x: event.clientX, y: event.clientY }
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = pointerStart.current
    pointerStart.current = null
    const scale = transformRef.current?.instance.state.scale ?? 1
    if (!start || scale > 1.01) return

    const deltaX = event.clientX - start.x
    const deltaY = event.clientY - start.y
    if (Math.abs(deltaX) < SWIPE_THRESHOLD || Math.abs(deltaX) < Math.abs(deltaY)) return
    if (deltaX > 0 && canGoPrev) goPrev()
    if (deltaX < 0 && canGoNext) goNext()
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        showCloseButton={false}
        onKeyDown={handleKeyDown}
        className={cn(
          "flex h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-none flex-col gap-0 overflow-hidden rounded-2xl border-white/10 bg-[#0b0d10] p-0 text-white shadow-2xl",
          "sm:h-[min(820px,calc(100dvh-2rem))] sm:w-[min(1120px,calc(100vw-2rem))] sm:max-w-none",
        )}
      >
        <DialogTitle className="sr-only">Image viewer</DialogTitle>
        <DialogDescription className="sr-only">
          View and navigate images from this session.
        </DialogDescription>

        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-white/10 bg-black/20 px-2.5 sm:px-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-white/[0.06]">
            <ImageIcon className="size-3.5 text-white/65" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-white/90">
              {current.label || current.alt || "Session image"}
            </div>
            {hasMultiple && (
              <div className="text-[10px] tabular-nums text-white/45">
                {index + 1} of {images.length}
              </div>
            )}
          </div>

          <div className="flex items-center gap-1">
            <IconButton
              label="Zoom out"
              disabled={zoomPercent <= 100}
              onClick={zoomOut}
            >
              <Minus className="size-3.5" />
            </IconButton>
            <button
              type="button"
              onClick={resetZoom}
              className="h-8 min-w-12 rounded-md px-1.5 font-mono text-[10px] tabular-nums text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white"
              aria-label="Reset zoom"
              title="Reset zoom"
            >
              {zoomPercent}%
            </button>
            <IconButton
              label="Zoom in"
              disabled={zoomPercent >= MAX_ZOOM * 100}
              onClick={zoomIn}
            >
              <Plus className="size-3.5" />
            </IconButton>
            <div className="mx-1 h-5 w-px bg-white/10" />
            <IconButton label="Close image viewer" onClick={onClose}>
              <X className="size-4" />
            </IconButton>
          </div>
        </header>

        <div
          className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.055),transparent_65%)]"
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
        >
          <TransformWrapper
            key={current.id}
            ref={transformRef}
            minScale={1}
            maxScale={MAX_ZOOM}
            centerOnInit
            centerZoomedOut
            doubleClick={{ mode: "toggle" }}
            // Additive zoom: effective step = step × |wheel deltaY| (`smooth`
            // default). 0.005 ≈ +0.6 per mouse notch, proportional on trackpads.
            wheel={{ step: 0.005 }}
            onTransform={(_ref, state) => setZoomPercent(Math.round(state.scale * 100))}
          >
            <TransformComponent
              wrapperStyle={{ width: "100%", height: "100%" }}
              contentStyle={{ width: "100%", height: "100%" }}
              contentClass="flex items-center justify-center p-3 sm:p-6"
            >
              <img
                src={current.src}
                alt={current.alt}
                draggable={false}
                className={cn(
                  "max-h-full max-w-full select-none object-contain shadow-2xl",
                  isZoomedIn ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
                )}
              />
            </TransformComponent>
          </TransformWrapper>

          {hasMultiple && (
            <>
              <IconButton
                label="Previous image"
                disabled={!canGoPrev}
                onClick={goPrev}
                className="absolute left-2 top-1/2 size-10 -translate-y-1/2 rounded-full bg-black/45 backdrop-blur sm:left-3"
              >
                <ChevronLeft className="size-5" />
              </IconButton>
              <IconButton
                label="Next image"
                disabled={!canGoNext}
                onClick={goNext}
                className="absolute right-2 top-1/2 size-10 -translate-y-1/2 rounded-full bg-black/45 backdrop-blur sm:right-3"
              >
                <ChevronRight className="size-5" />
              </IconButton>
            </>
          )}

          {zoomPercent === 100 && (
            <div className="pointer-events-none absolute bottom-2 left-1/2 hidden -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/45 px-2.5 py-1 text-[10px] text-white/45 backdrop-blur sm:flex">
              <Maximize2 className="size-3" />
              Scroll or double-click to zoom · drag to pan
            </div>
          )}
        </div>

        {hasMultiple && (
          <footer className="shrink-0 border-t border-white/10 bg-black/25 px-2 py-2">
            <div className="flex gap-1.5 overflow-x-auto overscroll-x-contain pb-0.5">
              {images.map((image, imageIndex) => (
                <button
                  key={image.id}
                  type="button"
                  onClick={() => goTo(imageIndex)}
                  aria-label={`View image ${imageIndex + 1}`}
                  aria-current={imageIndex === index ? "true" : undefined}
                  className={cn(
                    "relative size-12 shrink-0 overflow-hidden rounded-md border bg-white/[0.04] p-0.5 transition-all sm:h-14 sm:w-[4.5rem]",
                    imageIndex === index
                      ? "border-blue-400 ring-1 ring-blue-400/35"
                      : "border-white/10 opacity-55 hover:border-white/25 hover:opacity-90",
                  )}
                >
                  <img
                    src={image.src}
                    alt=""
                    draggable={false}
                    className="size-full rounded-[3px] object-cover"
                  />
                  <span className="absolute bottom-0.5 right-0.5 rounded bg-black/65 px-1 font-mono text-[8px] text-white/70">
                    {imageIndex + 1}
                  </span>
                </button>
              ))}
            </div>
          </footer>
        )}
      </DialogContent>
    </Dialog>
  )
}
