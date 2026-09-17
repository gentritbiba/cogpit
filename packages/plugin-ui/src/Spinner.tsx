import { ProcessingIcon } from "./StatusIcons.js"
import { cn } from "./utils.js"
import type { ComponentProps } from "react"

export function Spinner({ className, ...props }: ComponentProps<"svg">) {
  // Remove animate-spin to avoid double rotation since ProcessingIcon animates internally
  const cleanClass = className?.replace(/\banimate-spin\b/g, "").trim()
  return <ProcessingIcon className={cn(cleanClass)} {...props} />
}
