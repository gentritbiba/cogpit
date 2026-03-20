import { useEffect, useCallback, useState } from "react"
import { X } from "lucide-react"
import { FullDiffView } from "./FullDiffView"

export interface DiffViewModalProps {
  oldContent: string
  newContent: string
  filePath: string
  additions?: number
  deletions?: number
  onClose: () => void
}

export function DiffViewModal({
  oldContent,
  newContent,
  filePath,
  additions,
  deletions,
  onClose,
}: DiffViewModalProps) {
  const [mode, setMode] = useState<"split" | "unified">("split")

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    },
    [onClose],
  )

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown)
    // Prevent background scroll
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", handleKeyDown)
      document.body.style.overflow = ""
    }
  }, [handleKeyDown])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-mono text-sm truncate">{filePath}</span>
          {(additions !== undefined || deletions !== undefined) && (
            <span className="text-xs text-muted-foreground shrink-0">
              {additions !== undefined && <span className="text-green-500">+{additions}</span>}
              {deletions !== undefined && (
                <span className="text-red-500 ml-1">-{deletions}</span>
              )}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            className="px-2 py-1 text-xs rounded border hover:bg-accent"
            onClick={() => setMode(mode === "split" ? "unified" : "split")}
          >
            {mode === "split" ? "Unified" : "Split"}
          </button>
          <button
            className="p-1 rounded hover:bg-accent"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Diff content */}
      <div className="flex-1 overflow-auto">
        <FullDiffView
          oldContent={oldContent}
          newContent={newContent}
          filePath={filePath}
          mode={mode}
        />
      </div>
    </div>
  )
}
