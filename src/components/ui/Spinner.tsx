import { ProcessingIcon } from "./StatusIcons"
import { cn } from "@/lib/utils"
import type { ComponentProps } from "react"

export function Spinner({ className, ...props }: ComponentProps<"svg">) {
  // Remove animate-spin to avoid double rotation since ProcessingIcon animates internally
  const cleanClass = className?.replace(/\banimate-spin\b/g, "").trim()
  return <ProcessingIcon className={cn(cleanClass)} {...props} />
}
