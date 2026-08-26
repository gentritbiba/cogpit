import { useState, useEffect, useCallback } from "react"
import { Palette, Check } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group"
import { type ThemeId, themes } from "@/hooks/useTheme"
import { chatWidths, useChatWidth } from "@/lib/chatWidth"

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
  const [chatWidth, setChatWidth] = useChatWidth()

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

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-sm gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b p-4 pr-12">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Palette data-icon="inline-start" className="size-4 text-muted-foreground" />
            Appearance
          </DialogTitle>
          <DialogDescription>Preview a color theme and set the chat width.</DialogDescription>
        </DialogHeader>

        <ToggleGroup
          aria-label="Theme"
          orientation="vertical"
          value={[themes[selectedIndex].id]}
          className="w-full items-stretch p-1"
        >
          {themes.map((theme, i) => (
            <ToggleGroupItem
              key={theme.id}
              value={theme.id}
              className="h-auto w-full justify-start gap-3 px-3 py-2.5 text-left text-muted-foreground data-pressed:bg-accent data-pressed:text-accent-foreground"
              onClick={() => handleSelect(theme)}
              onMouseEnter={() => setSelectedIndex(i)}
              onFocus={() => setSelectedIndex(i)}
            >
              <div className="flex gap-1">
                {theme.swatches.map((color, j) => (
                  <div
                    key={j}
                    className="size-4 rounded-full border"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>

              <span className="flex-1 text-sm font-medium">{theme.name}</span>

              {currentTheme === theme.id && (
                <Check data-icon="inline-end" className="size-4 shrink-0 text-foreground" />
              )}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <div className="border-t p-3">
          <div className="px-1 pb-2 text-xs font-medium text-muted-foreground">Chat width</div>
          <ToggleGroup
            aria-label="Chat width"
            value={[chatWidth]}
            className="w-full items-stretch gap-1"
          >
            {chatWidths.map((width) => (
              <ToggleGroupItem
                key={width.id}
                value={width.id}
                className="flex-1 text-xs text-muted-foreground data-pressed:bg-accent data-pressed:text-accent-foreground"
                onClick={() => setChatWidth(width.id)}
              >
                {width.name}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </DialogContent>
    </Dialog>
  )
}
