import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react"
import { X, ChevronUp, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"

export interface FindInSessionHandle {
  open: () => void
  close: () => void
  isOpen: boolean
}

interface FindInSessionProps {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
}

const HIGHLIGHT_CLASS = "find-in-session-highlight"
const ACTIVE_CLASS = "find-in-session-active"

function getTextNodes(root: Node): Text[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
  let node: Text | null
  while ((node = walker.nextNode() as Text | null)) {
    if (node.nodeValue && node.nodeValue.trim().length > 0) {
      nodes.push(node)
    }
  }
  return nodes
}

export const FindInSession = forwardRef<FindInSessionHandle, FindInSessionProps>(
  function FindInSession({ scrollContainerRef }, ref) {
    const [isOpen, setIsOpen] = useState(false)
    const [query, setQuery] = useState("")
    const [matches, setMatches] = useState<HTMLElement[]>([])
    const [activeIndex, setActiveIndex] = useState(-1)
    const inputRef = useRef<HTMLInputElement>(null)

    const clearHighlights = useCallback(() => {
      const container = scrollContainerRef.current
      if (!container) return
      const marks = container.querySelectorAll(`mark.${HIGHLIGHT_CLASS}`)
      marks.forEach((mark) => {
        const parent = mark.parentNode
        if (parent) {
          parent.replaceChild(document.createTextNode(mark.textContent || ""), mark)
          parent.normalize()
        }
      })
    }, [scrollContainerRef])

    const performSearch = useCallback(
      (searchQuery: string) => {
        clearHighlights()
        if (!searchQuery || !scrollContainerRef.current) {
          setMatches([])
          setActiveIndex(-1)
          return
        }

        const container = scrollContainerRef.current
        const textNodes = getTextNodes(container)
        const lowerQuery = searchQuery.toLowerCase()
        const newMarks: HTMLElement[] = []

        for (const textNode of textNodes) {
          const text = textNode.nodeValue || ""
          const lowerText = text.toLowerCase()
          let startIdx = 0
          const indices: number[] = []

          while (true) {
            const idx = lowerText.indexOf(lowerQuery, startIdx)
            if (idx === -1) break
            indices.push(idx)
            startIdx = idx + 1
          }

          if (indices.length === 0) continue

          // Split text node and wrap matches in <mark> elements
          const parent = textNode.parentNode
          if (!parent) continue

          const frag = document.createDocumentFragment()
          let lastEnd = 0

          for (const idx of indices) {
            if (idx > lastEnd) {
              frag.appendChild(document.createTextNode(text.slice(lastEnd, idx)))
            }
            const mark = document.createElement("mark")
            mark.className = HIGHLIGHT_CLASS
            mark.textContent = text.slice(idx, idx + searchQuery.length)
            frag.appendChild(mark)
            newMarks.push(mark)
            lastEnd = idx + searchQuery.length
          }

          if (lastEnd < text.length) {
            frag.appendChild(document.createTextNode(text.slice(lastEnd)))
          }

          parent.replaceChild(frag, textNode)
        }

        setMatches(newMarks)
        if (newMarks.length > 0) {
          setActiveIndex(0)
          newMarks[0].classList.add(ACTIVE_CLASS)
          newMarks[0].scrollIntoView({ block: "center", behavior: "smooth" })
        } else {
          setActiveIndex(-1)
        }
      },
      [scrollContainerRef, clearHighlights]
    )

    const goToMatch = useCallback(
      (index: number) => {
        if (matches.length === 0) return
        // Remove active class from current
        if (activeIndex >= 0 && activeIndex < matches.length) {
          matches[activeIndex].classList.remove(ACTIVE_CLASS)
        }
        const wrapped = ((index % matches.length) + matches.length) % matches.length
        matches[wrapped].classList.add(ACTIVE_CLASS)
        matches[wrapped].scrollIntoView({ block: "center", behavior: "smooth" })
        setActiveIndex(wrapped)
      },
      [matches, activeIndex]
    )

    const handleClose = useCallback(() => {
      setIsOpen(false)
      setQuery("")
      clearHighlights()
      setMatches([])
      setActiveIndex(-1)
    }, [clearHighlights])

    useImperativeHandle(
      ref,
      () => ({
        open: () => {
          setIsOpen(true)
          // Focus input after render
          requestAnimationFrame(() => inputRef.current?.focus())
        },
        close: handleClose,
        isOpen,
      }),
      [handleClose, isOpen]
    )

    // Re-search when query changes (debounced)
    useEffect(() => {
      const timer = setTimeout(() => performSearch(query), 150)
      return () => clearTimeout(timer)
    }, [query, performSearch])

    // Clean up on unmount
    useEffect(() => {
      return () => clearHighlights()
    }, [clearHighlights])

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        handleClose()
      } else if (e.key === "Enter") {
        e.preventDefault()
        if (e.shiftKey) {
          goToMatch(activeIndex - 1)
        } else {
          goToMatch(activeIndex + 1)
        }
      }
    }

    if (!isOpen) return null

    return (
      <div className="motion-slide-down-in absolute right-4 top-0 z-30 flex items-center gap-1 rounded-b-lg border border-t-0 bg-popover p-2 text-popover-foreground shadow-sm">
        <InputGroup className="w-64">
          <InputGroupInput
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Find in conversation"
            aria-label="Find in conversation"
            autoFocus
          />
          <InputGroupAddon align="inline-end">
            <span className="min-w-12 text-center text-xs tabular-nums">
              {query
                ? matches.length > 0
                  ? `${activeIndex + 1}/${matches.length}`
                  : "0/0"
                : ""}
            </span>
          </InputGroupAddon>
        </InputGroup>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => goToMatch(activeIndex - 1)}
          disabled={matches.length === 0}
          className={cn(
            "text-muted-foreground",
            matches.length > 0
              ? "hover:text-foreground"
              : "cursor-default opacity-40"
          )}
          aria-label="Previous match"
        >
          <ChevronUp data-icon="inline-start" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => goToMatch(activeIndex + 1)}
          disabled={matches.length === 0}
          className={cn(
            "text-muted-foreground",
            matches.length > 0
              ? "hover:text-foreground"
              : "cursor-default opacity-40"
          )}
          aria-label="Next match"
        >
          <ChevronDown data-icon="inline-start" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={handleClose}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Close search"
        >
          <X data-icon="inline-start" />
        </Button>
      </div>
    )
  }
)
