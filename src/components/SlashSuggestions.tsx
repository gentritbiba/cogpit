import { memo, useCallback, useEffect, useRef } from "react"
import { Terminal, Sparkles, Loader2, Pencil } from "lucide-react"
import type { SlashSuggestion } from "@/hooks/useSlashSuggestions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"

interface SlashSuggestionsProps {
  suggestions: SlashSuggestion[]
  filter: string // text after "/" to filter by
  loading: boolean
  selectedIndex: number
  onSelect: (suggestion: SlashSuggestion) => void
  onHover: (index: number) => void
  onEdit?: (filePath: string) => void
}

function getSourceBadge(suggestion: SlashSuggestion) {
  return (
    <Badge variant={suggestion.source === "built-in" ? "secondary" : "outline"}>
      {suggestion.source}
    </Badge>
  )
}

export const SlashSuggestions = memo(function SlashSuggestions({
  suggestions,
  filter,
  loading,
  selectedIndex,
  onSelect,
  onHover,
  onEdit,
}: SlashSuggestionsProps) {
  const itemRefs = useRef<Map<number, HTMLElement>>(new Map())

  // Scroll selected item into view
  useEffect(() => {
    const el = itemRefs.current.get(selectedIndex)
    if (el) {
      el.scrollIntoView?.({ block: "nearest" })
    }
  }, [selectedIndex])

  if (loading) {
    return (
      <div className="motion-popover-in absolute bottom-full left-0 right-0 z-50 mx-auto mb-2 max-w-3xl">
        <div className="flex items-center gap-2 rounded-lg border bg-popover p-3 text-popover-foreground shadow-sm">
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Loading suggestions...</span>
        </div>
      </div>
    )
  }

  if (suggestions.length === 0) {
    return (
      <div className="motion-popover-in absolute bottom-full left-0 right-0 z-50 mx-auto mb-2 max-w-3xl">
        <div className="rounded-lg border bg-popover p-3 text-popover-foreground shadow-sm">
          <span className="text-xs text-muted-foreground">
            {filter ? `No commands or skills matching "${filter}"` : "No commands or skills found"}
          </span>
        </div>
      </div>
    )
  }

  const commands = suggestions.filter((suggestion) => suggestion.type === "command")
  const groups = [
    { heading: "Commands", suggestions: commands, offset: 0 },
    {
      heading: "Skills",
      suggestions: suggestions.filter((suggestion) => suggestion.type === "skill"),
      offset: commands.length,
    },
  ]

  return (
    <div className="motion-popover-in absolute bottom-full left-0 right-0 z-50 mx-auto mb-2 max-w-3xl">
      <Command
        id="slash-suggestions"
        value={suggestions[selectedIndex] ? `${suggestions[selectedIndex].type}-${suggestions[selectedIndex].name}` : undefined}
        onValueChange={(value) => {
          const index = suggestions.findIndex((suggestion) => `${suggestion.type}-${suggestion.name}` === value)
          if (index >= 0) onHover(index)
        }}
        shouldFilter={false}
        className="border shadow-sm"
      >
        <CommandList>
          {groups.map((group) => group.suggestions.length > 0 && (
            <CommandGroup key={group.heading} heading={group.heading}>
              {group.suggestions.map((suggestion, index) => {
                const globalIndex = group.offset + index
                return (
                  <SuggestionItem
                    key={`${suggestion.type}-${suggestion.name}`}
                    suggestion={suggestion}
                    index={globalIndex}
                    isSelected={globalIndex === selectedIndex}
                    onSelect={onSelect}
                    onHover={onHover}
                    onEdit={onEdit}
                    itemRefs={itemRefs}
                  />
                )
              })}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </div>
  )
})

function SuggestionItem({
  suggestion,
  index,
  isSelected,
  onSelect,
  onHover,
  onEdit,
  itemRefs,
}: {
  suggestion: SlashSuggestion
  index: number
  isSelected: boolean
  onSelect: (s: SlashSuggestion) => void
  onHover: (i: number) => void
  onEdit?: (filePath: string) => void
  itemRefs: React.MutableRefObject<Map<number, HTMLElement>>
}) {
  const setRef = useCallback(
    (el: HTMLElement | null) => {
      if (el) {
        el.id = `slash-suggestion-${index}`
        itemRefs.current.set(index, el)
      } else {
        itemRefs.current.delete(index)
      }
    },
    [index, itemRefs],
  )

  return (
    <div className="group/suggestion relative">
      <CommandItem
        ref={setRef}
        value={`${suggestion.type}-${suggestion.name}`}
        className="items-start gap-2.5 px-2 py-2 pr-10"
        onMouseEnter={() => onHover(index)}
        onSelect={() => onSelect(suggestion)}
        onMouseDown={(e) => {
          e.preventDefault()
        }}
      >
        <div className="mt-0.5 shrink-0">
          {suggestion.type === "command" ? (
            <Terminal className="size-4 text-muted-foreground" />
          ) : (
            <Sparkles className="size-4 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-medium text-foreground">
              /{suggestion.name}
            </span>
            {getSourceBadge(suggestion)}
          </div>
          {suggestion.description && (
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
              {suggestion.description}
            </p>
          )}
        </div>
        {isSelected && (
          <CommandShortcut className={onEdit && suggestion.filePath ? "mr-6" : undefined}>
            Enter
          </CommandShortcut>
        )}
      </CommandItem>
      {onEdit && suggestion.filePath && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover/suggestion:opacity-100 focus-visible:opacity-100"
          onMouseDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onEdit(suggestion.filePath)
          }}
          aria-label={`Edit ${suggestion.name}`}
        >
          <Pencil data-icon="inline-start" />
        </Button>
      )}
    </div>
  )
}
