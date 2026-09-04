import { useState } from "react"
import { cn } from "@/lib/utils"
import { StreamingMarkdown } from "@/components/timeline/StreamingMarkdown"

/** Descriptions past this size start folded so what follows them stays within reach. */
const LONG_BODY_CHARS = 700
const LONG_BODY_LINES = 12

export function Description({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false)
  const long = body.length > LONG_BODY_CHARS || body.split("\n").length > LONG_BODY_LINES
  return (
    <div className="max-w-[72ch]">
      <div
        className={cn(
          "break-words text-xs leading-5",
          long && !expanded && "max-h-52 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]",
        )}
      >
        <StreamingMarkdown text={body} compactHeadings />
      </div>
      {long && (
        <button
          type="button"
          className="mt-1 text-[11px] text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:underline"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? "Show less" : "Show full description"}
        </button>
      )}
    </div>
  )
}
