import { useState, useEffect, useRef, useCallback } from "react"
import { Palette, Check } from "lucide-react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { type ThemeId, themes } from "@/hooks/useTheme"

interface ThemeSelectorModalProps {
  open: boolean
  onClose: () => void
  currentTheme: ThemeId
  onSelectTheme: (id: ThemeId) => void
  onPreviewTheme: (id: ThemeId | null) => void
}

export function ThemeSelectorModal({
  open,
  onClose,
  currentTheme,
  onSelectTheme,
  onPreviewTheme,
}: ThemeSelectorModalProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Reset selection to current theme when modal opens
  useEffect(() => {
    if (open) {
      const idx = themes.findIndex((t) => t.id === currentTheme)
      setSelectedIndex(idx >= 0 ? idx : 0)
    }
  }, [open, currentTheme])

  // Live preview as selection changes
  useEffect(() => {
    if (open) {
      onPreviewTheme(themes[selectedIndex].id)
    }
  }, [selectedIndex, open, onPreviewTheme])

  // Clear preview when modal closes
  useEffect(() => {
    if (!open) {
      onPreviewTheme(null)
    }
  }, [open, onPreviewTheme])

  const handleSelect = useCallback(
    (theme: (typeof themes)[number]) => {
      onSelectTheme(theme.id)
      onClose()
    },
    [onSelectTheme, onClose]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, themes.length - 1))
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === "Enter") {
        e.preventDefault()
        handleSelect(themes[selectedIndex])
      }
    },
    [selectedIndex, handleSelect]
  )

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent
        className="max-w-sm p-0 elevation-4 border-border/30 gap-0 overflow-hidden [&>button:last-child]:hidden"
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Palette className="size-4 text-muted-foreground shrink-0" />
          <span className="text-sm text-foreground font-medium">Select Theme</span>
          <div className="ml-auto flex items-center gap-1.5">
            <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-border/70 bg-elevation-2 px-1.5 py-0.5 text-[10px] text-muted-foreground font-mono">
              &uarr;&darr;
            </kbd>
            <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-border/70 bg-elevation-2 px-1.5 py-0.5 text-[10px] text-muted-foreground font-mono">
              ESC
            </kbd>
          </div>
        </div>

        {/* Theme list */}
        <div ref={listRef} className="py-1">
          {themes.map((theme, i) => (
            <button
              key={theme.id}
              data-theme-item
              className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                i === selectedIndex
                  ? "bg-elevation-2 text-foreground"
                  : "text-muted-foreground hover:bg-elevation-1 hover:text-foreground"
              }`}
              onClick={() => handleSelect(theme)}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              {/* Elevation swatch strip */}
              <div className="flex gap-1">
                {theme.swatches.map((color, j) => (
                  <div
                    key={j}
                    className="size-4 rounded-full border border-white/10"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>

              <span className="flex-1 text-sm font-medium">{theme.name}</span>

              {currentTheme === theme.id && (
                <Check className="size-3.5 text-blue-400 shrink-0" />
              )}

              {i === selectedIndex && (
                <kbd className="hidden sm:inline-flex items-center rounded border border-border/70 bg-elevation-2 px-1.5 py-0.5 text-[10px] text-muted-foreground font-mono">
                  &crarr;
                </kbd>
              )}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
