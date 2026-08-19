import type { ReactElement, ReactNode } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/**
 * Explains why a control is unavailable instead of removing it.
 *
 * Hiding a disabled feature teaches the user it does not exist; showing it with
 * its precondition teaches them how to unlock it. Pass no reason and this is a
 * pass-through, so a call site can go from available to explained without
 * changing shape.
 *
 * The wrapper span carries the hover because a disabled control does not emit
 * pointer events of its own.
 */
export function DisabledHint({
  reason,
  children,
}: {
  reason?: string
  children: ReactElement
}): ReactNode {
  if (!reason) return children

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" tabIndex={0} aria-label={reason} />}>
        {children}
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}
