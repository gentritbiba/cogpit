import { useEffect, useRef } from "react"
import { Pencil, Trash2 } from "lucide-react"
import type { ConfigItem } from "./config-types"

interface ItemContextPopupProps {
  item: ConfigItem
  position: { x: number; y: number }
  onRename: () => void
  onDelete: () => void
  onClose: () => void
}

export function ItemContextPopup({
  item,
  position,
  onRename,
  onDelete,
  onClose,
}: ItemContextPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleMouseDown(e: MouseEvent): void {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) onClose()
    }
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", handleMouseDown)
    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("mousedown", handleMouseDown)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [onClose])

  return (
    <div
      ref={popupRef}
      className="fixed z-50 min-w-[120px] bg-elevation-2 border border-border rounded-md shadow-lg py-1"
      style={{ left: position.x, top: position.y }}
    >
      {item.readOnly ? (
        <p className="px-3 py-1.5 text-[10px] text-muted-foreground/50">Read-only file</p>
      ) : (
        <>
          <button
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-foreground/80 hover:bg-elevation-3 hover:text-foreground transition-colors"
            onClick={() => { onRename(); onClose() }}
          >
            <Pencil className="size-3" />
            Rename
          </button>
          <button
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-red-400/80 hover:bg-red-500/10 hover:text-red-400 transition-colors"
            onClick={() => { onDelete(); onClose() }}
          >
            <Trash2 className="size-3" />
            Delete
          </button>
        </>
      )}
    </div>
  )
}
