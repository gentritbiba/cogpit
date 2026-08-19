/**
 * The +N / −M diffstat renderers.
 *
 * Previously duplicated file-locally in TurnChangedFiles and GroupedFileCard.
 * Shared so every surface that reports line changes looks identical.
 */

import { cn } from "@/lib/utils"

/** Compact "+12 -3" line counts. Renders nothing for a zero-change entry. */
export function LineCounts({
  add,
  del,
  dimmed,
  className,
}: {
  add: number
  del: number
  dimmed?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums",
        dimmed && "opacity-40",
        className,
      )}
    >
      {add > 0 && <span className="text-success">+{add}</span>}
      {del > 0 && <span className="text-destructive">-{del}</span>}
    </span>
  )
}

const CHANGE_BAR_BLOCKS = 5

/** GitHub-style five-block meter showing the add/delete ratio. */
export function ChangeBar({ add, del }: { add: number; del: number }) {
  const total = add + del
  if (total === 0) return null
  const addBlocks = Math.round((add / total) * CHANGE_BAR_BLOCKS)
  const delBlocks = CHANGE_BAR_BLOCKS - addBlocks
  return (
    <span className="flex items-center gap-[1px] shrink-0 ml-1">
      {Array.from({ length: addBlocks }, (_, i) => (
        <span key={`a${i}`} className="inline-block size-1.5 rounded-xs bg-success/70" />
      ))}
      {Array.from({ length: delBlocks }, (_, i) => (
        <span key={`d${i}`} className="inline-block size-1.5 rounded-xs bg-destructive/70" />
      ))}
    </span>
  )
}
