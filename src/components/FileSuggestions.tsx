import { useEffect, useRef } from "react"
import { File, Loader2 } from "lucide-react"
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command"

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
  const itemRefs = useRef<Map<number, HTMLElement>>(new Map())

  useEffect(() => {
    itemRefs.current.get(selectedIndex)?.scrollIntoView?.({ block: "nearest" })
  }, [selectedIndex])

  return (
    <div className="motion-popover-in absolute bottom-full left-0 right-0 z-50 mx-auto mb-1.5 max-w-3xl">
      <Command
        id="file-suggestions"
        value={files[selectedIndex]}
        onValueChange={(value) => {
          const index = files.indexOf(value)
          if (index >= 0) onHover(index)
        }}
        shouldFilter={false}
        className="border shadow-sm"
      >
        <CommandList className="max-h-70">
          <CommandGroup
            heading={(
              <span className="flex items-center justify-between">
                Project files
                {loading && <Loader2 data-icon="inline-end" aria-label="Loading project files" className="size-3.5 animate-spin" />}
              </span>
            )}
          >
            {!loading && files.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {query ? `No files matching “${query}”` : "No project files found"}
              </p>
            ) : (
              files.map((path, index) => (
                <CommandItem
                  key={path}
                  ref={(element) => {
                    if (element) {
                      element.id = `file-suggestion-${index}`
                      itemRefs.current.set(index, element)
                    } else {
                      itemRefs.current.delete(index)
                    }
                  }}
                  value={path}
                  onMouseEnter={() => onHover(index)}
                  onSelect={() => onSelect(path)}
                  onMouseDown={(event) => event.preventDefault()}
                >
                  <File data-icon="inline-start" aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{path}</span>
                  {index === selectedIndex && <span className="text-xs text-muted-foreground">↵</span>}
                </CommandItem>
              ))
            )}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  )
}
