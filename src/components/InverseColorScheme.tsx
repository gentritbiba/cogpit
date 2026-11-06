import type { ComponentProps } from "react"
import { InvertedColorScheme } from "@/hooks/useIsDarkMode"
import { cn } from "@/lib/utils"

/**
 * Content drawn on the opposite theme: light on a dark page, dark on a light
 * one. Color tokens, `dark:` utilities and code highlighting all flip inside.
 */
export function InverseColorScheme({ className, ...props }: ComponentProps<"div">) {
  return (
    <InvertedColorScheme.Provider value>
      <div {...props} className={cn("color-scheme-inverse", className)} />
    </InvertedColorScheme.Provider>
  )
}
