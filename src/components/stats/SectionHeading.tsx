import type { ReactNode } from "react"

interface SectionHeadingProps {
  children: ReactNode
}

export function SectionHeading({ children }: SectionHeadingProps): JSX.Element {
  return (
    <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
      <span className="h-3.5 w-0.5 rounded-full bg-blue-500/40" />
      {children}
    </h3>
  )
}
