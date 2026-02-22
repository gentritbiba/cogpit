import { RotateCcw, ChevronsRight } from "lucide-react"
import { Button } from "@/components/ui/button"

interface UndoRedoBarProps {
  redoTurnCount: number
  onRedoAll: () => void
}

export function UndoRedoBar({ redoTurnCount, onRedoAll }: UndoRedoBarProps) {
  if (redoTurnCount <= 0) return null

  return (
    <div className="sticky bottom-0 z-20 flex items-center justify-center px-4 py-2">
      <div className="flex items-center gap-3 rounded-full border border-border/70 elevation-3 glass px-4 py-2">
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <RotateCcw className="size-3.5 text-amber-400" />
          <span className="font-mono">{redoTurnCount}</span>
          <span>turn{redoTurnCount !== 1 ? "s" : ""} archived</span>
        </div>
        <div className="h-4 w-px bg-border/70" />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-blue-400 hover:text-blue-300 gap-1"
          onClick={onRedoAll}
        >
          <ChevronsRight className="size-3.5" />
          Redo All
        </Button>
      </div>
    </div>
  )
}
