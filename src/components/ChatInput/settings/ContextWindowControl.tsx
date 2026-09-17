import { formatTokenCount } from "@/lib/format"
import { Button } from "@/components/ui/button"

interface ContextWindowControlProps {
  value: number | null
  onChange: (tokens: number | null) => void
}

const PRESET_TOKENS = [270000, 500000, 1000000]

function formatLimit(tokens: number): string {
  return PRESET_TOKENS.includes(tokens)
    ? formatTokenCount(tokens).replace(/\.0(?=[kM]$)/, "")
    : tokens.toLocaleString("en-US")
}

export function ContextWindowControl({ value, onChange }: ContextWindowControlProps) {
  const label = value === null ? "Default" : formatLimit(value)
  const next = PRESET_TOKENS[(PRESET_TOKENS.indexOf(value ?? 0) + 1) % PRESET_TOKENS.length]

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="h-6 shrink-0 tabular-nums"
      aria-label={`Context window: ${label}`}
      title={`Context window: ${label}. Click to use ${formatLimit(next)} next turn. Models with long-context pricing charge higher rates above 272k input tokens. This is not a hard billing cap.`}
      onClick={() => onChange(next)}
    >
      {label}
    </Button>
  )
}
