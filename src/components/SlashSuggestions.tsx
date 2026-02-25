import { memo, useCallback, useEffect, useRef } from "react"
import { Terminal, Sparkles, Loader2, Pencil } from "lucide-react"
import { cn } from "@/lib/utils"
import type { SlashSuggestion } from "@/hooks/useSlashSuggestions"

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
  if (suggestion.source === "project") {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-medium bg-green-500/15 text-green-400 border border-green-500/20">
        project
      </span>
    )
  }
  if (suggestion.source === "user") {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-medium bg-blue-500/15 text-blue-400 border border-blue-500/20">
        user
      </span>
    )
  }
  // Plugin name
  return (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-medium bg-purple-500/15 text-purple-400 border border-purple-500/20">
      {suggestion.source}
    </span>
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
  const listRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Map<number, HTMLElement>>(new Map())

  // Group pre-filtered suggestions by type
  const commands = suggestions.filter((s) => s.type === "command")
  const skills = suggestions.filter((s) => s.type === "skill")

  // Scroll selected item into view
  useEffect(() => {
    const el = itemRefs.current.get(selectedIndex)
    if (el) {
      el.scrollIntoView({ block: "nearest" })
    }
  }, [selectedIndex])

  if (loading) {
    return (
      <div className="absolute bottom-full left-0 right-0 mb-1.5 mx-auto max-w-3xl">
        <div className="rounded-lg border border-border/60 bg-elevation-2 shadow-lg p-3 flex items-center gap-2">
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Loading suggestions...</span>
        </div>
      </div>
    )
  }

  if (suggestions.length === 0) {
    return (
      <div className="absolute bottom-full left-0 right-0 mb-1.5 mx-auto max-w-3xl">
        <div className="rounded-lg border border-border/60 bg-elevation-2 shadow-lg p-3">
          <span className="text-xs text-muted-foreground">
            {filter ? `No commands or skills matching "${filter}"` : "No commands or skills found"}
          </span>
        </div>
      </div>
    )
  }

  let globalIndex = 0

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1.5 mx-auto max-w-3xl z-50">
      <div
        ref={listRef}
        className="rounded-lg border border-border/60 bg-elevation-2 shadow-lg overflow-y-auto max-h-[280px]"
        role="listbox"
      >
        {commands.length > 0 && (
          <>
            <div className="sticky top-0 bg-elevation-2 px-3 pt-2 pb-1 border-b border-border/30">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Commands
              </span>
            </div>
            {commands.map((suggestion) => {
              const idx = globalIndex++
              return (
                <SuggestionItem
                  key={`cmd-${suggestion.name}`}
                  suggestion={suggestion}
                  index={idx}
                  isSelected={idx === selectedIndex}
                  onSelect={onSelect}
                  onHover={onHover}
                  onEdit={onEdit}
                  itemRefs={itemRefs}
                />
              )
            })}
          </>
        )}
        {skills.length > 0 && (
          <>
            <div className="sticky top-0 bg-elevation-2 px-3 pt-2 pb-1 border-b border-border/30">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Skills
              </span>
            </div>
            {skills.map((suggestion) => {
              const idx = globalIndex++
              return (
                <SuggestionItem
                  key={`skill-${suggestion.name}`}
                  suggestion={suggestion}
                  index={idx}
                  isSelected={idx === selectedIndex}
                  onSelect={onSelect}
                  onHover={onHover}
                  onEdit={onEdit}
                  itemRefs={itemRefs}
                />
              )
            })}
          </>
        )}
      </div>
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
      if (el) itemRefs.current.set(index, el)
      else itemRefs.current.delete(index)
    },
    [index, itemRefs],
  )

  return (
    <div
      ref={setRef}
      className={cn(
        "group flex items-start gap-2.5 px-3 py-2 cursor-pointer transition-colors duration-75",
        isSelected ? "bg-blue-500/10" : "hover:bg-elevation-3",
      )}
      role="option"
      aria-selected={isSelected}
      onMouseEnter={() => onHover(index)}
      onMouseDown={(e) => {
        e.preventDefault() // don't blur textarea
        onSelect(suggestion)
      }}
    >
      <div className="mt-0.5 shrink-0">
        {suggestion.type === "command" ? (
          <Terminal className="size-3.5 text-blue-400" />
        ) : (
          <Sparkles className="size-3.5 text-purple-400" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground font-mono">
            /{suggestion.name}
          </span>
          {getSourceBadge(suggestion)}
        </div>
        {suggestion.description && (
          <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">
            {suggestion.description}
          </p>
        )}
      </div>
      {onEdit && suggestion.filePath && (
        <button
          className="self-center shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground hover:bg-elevation-3"
          onMouseDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onEdit(suggestion.filePath)
          }}
          aria-label={`Edit ${suggestion.name}`}
        >
          <Pencil className="size-3" />
        </button>
      )}
      {isSelected && (
        <span className="text-[10px] text-muted-foreground self-center shrink-0 font-mono">
          ↵
        </span>
      )}
    </div>
  )
}
