import { useState, useRef, useCallback, useEffect, type ReactNode } from "react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"

interface BottomSheetProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  /** Initial height as percentage of viewport (default: 50) */
  initialHeight?: number
  /** Maximum height as percentage of viewport (default: 92) */
  maxHeight?: number
  className?: string
}

/**
 * Draggable bottom sheet for mobile. Slides up from the bottom with a
 * drag handle. Swipe down to dismiss, drag up to expand.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  children,
  initialHeight = 50,
  maxHeight = 92,
  className,
}: BottomSheetProps) {
  const [height, setHeight] = useState(initialHeight)
  const heightRef = useRef(initialHeight)
  const sheetRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  // Reset height when opened
  useEffect(() => {
    if (open) {
      heightRef.current = initialHeight
      setHeight(initialHeight)
    }
  }, [open, initialHeight])

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    dragRef.current = {
      startY: e.touches[0].clientY,
      startHeight: heightRef.current,
    }
    setIsDragging(true)
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!dragRef.current) return
    const dy = dragRef.current.startY - e.touches[0].clientY
    const vh = window.innerHeight
    const deltaPercent = (dy / vh) * 100
    const newHeight = Math.min(maxHeight, Math.max(5, dragRef.current.startHeight + deltaPercent))
    heightRef.current = newHeight
    setHeight(newHeight)
  }, [maxHeight])

  const handleTouchEnd = useCallback(() => {
    if (!dragRef.current) return
    setIsDragging(false)
    // Dismiss if dragged below 15% of viewport
    if (heightRef.current < 15) {
      onClose()
    }
    dragRef.current = null
  }, [onClose])

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] animate-in fade-in-0 duration-200"
        onClick={onClose}
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-xl elevation-4 border-t border-border/40",
          !isDragging && "transition-[height] duration-200 ease-out",
          "animate-in slide-in-from-bottom duration-300",
          className,
        )}
        style={{ height: `${height}vh` }}
      >
        {/* Drag handle area */}
        <div
          className="flex flex-col items-center shrink-0 cursor-grab active:cursor-grabbing touch-none"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <div className="bottom-sheet-handle" />
          {title && (
            <div className="flex items-center w-full px-4 pb-2">
              <span className="text-sm font-medium text-foreground flex-1">{title}</span>
              <button
                onClick={onClose}
                className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-elevation-2 transition-colors"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
          {children}
        </div>
      </div>
    </>
  )
}
