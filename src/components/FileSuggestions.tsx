import { useEffect, useRef } from "react"
import { File, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

interface FileSuggestionsProps {
  files: string[]
  query: string
  loading: boolean
  selectedIndex: number
  onSelect: (path: string) => void
  onHover: (index: number) => void
}

export function FileSuggestions({
  files,
  query,
  loading,
  selectedIndex,
  onSelect,
  onHover,
}: FileSuggestionsProps) {
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  useEffect(() => {
    itemRefs.current.get(selectedIndex)?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  return (
    <div className="absolute bottom-full left-0 right-0 z-50 mx-auto mb-1.5 max-w-3xl">
      <div className="max-h-[280px] overflow-y-auto rounded-lg border border-border/60 bg-elevation-2 shadow-lg" role="listbox">
        <div className="sticky top-0 flex items-center justify-between border-b border-border/30 bg-elevation-2 px-3 py-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Project files
          </span>
          {loading && <Loader2 aria-label="Loading project files" className="size-3 animate-spin text-muted-foreground" />}
        </div>
        {!loading && files.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            {query ? `No files matching “${query}”` : "No project files found"}
          </p>
        ) : (
          files.map((path, index) => (
            <div
              key={path}
              ref={(element) => {
                if (element) itemRefs.current.set(index, element)
                else itemRefs.current.delete(index)
              }}
              role="option"
              aria-selected={index === selectedIndex}
              className={cn(
                "flex cursor-pointer items-center gap-2 px-3 py-2 text-sm",
                index === selectedIndex ? "bg-accent" : "hover:bg-elevation-3",
              )}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => {
                event.preventDefault()
                onSelect(path)
              }}
            >
              <File aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{path}</span>
              {index === selectedIndex && <span className="text-[10px] text-muted-foreground">↵</span>}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
