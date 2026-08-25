import { useState } from "react"
import { Sparkles, X } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * The CLI's predicted next prompt, offered above the composer.
 *
 * Clicking it fills the composer rather than sending, because the prediction is
 * a starting point the user is expected to edit. The CLI suppresses suggestions
 * on the first turn, in plan mode, after API errors and behind two separate
 * settings, so "no suggestion" is the common case and gets no reserved space.
 */
export function PromptSuggestionBar({
  suggestion,
  onAccept,
}: {
  suggestion: string | null
  onAccept: (suggestion: string) => void
}) {
  // Keyed by text, not a boolean: the next turn's suggestion is a different
  // offer and must reappear even though the previous one was waved away.
  const [dismissed, setDismissed] = useState<string | null>(null)

  if (!suggestion || suggestion === dismissed) return null

  return (
    <div className="motion-enter mb-1 flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        title="Put this in the composer"
        onClick={() => {
          setDismissed(suggestion)
          onAccept(suggestion)
        }}
        className="min-w-0 flex-1 justify-start text-muted-foreground"
      >
        <Sparkles data-icon="inline-start" />
        <span className="truncate">{suggestion}</span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Dismiss suggestion"
        onClick={() => setDismissed(suggestion)}
        className="shrink-0 text-muted-foreground"
      >
        <X />
      </Button>
    </div>
  )
}
