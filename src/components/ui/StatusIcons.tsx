import { cn } from "@/lib/utils"
import type { ComponentProps } from "react"

type IconProps = ComponentProps<"svg">

export function ProcessingIcon({ className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" className={cn("size-5", className)} {...props}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeOpacity="0.2" />
      <path
        className="status-icon-spin"
        d="M12 2A10 10 0 0 1 22 12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function CompletedIcon({ className, ...props }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-5", className)}
      {...props}
    >
      <path
        className="status-icon-complete"
        d="M20 6L9 17L4 12"
      />
    </svg>
  )
}

export function FailedIcon({ className, ...props }: IconProps) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={cn("size-5", className)} {...props}>
             <line x1="18" y1="6" x2="6" y2="18" />
             <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
    )
}

export function RunningIcon({ className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" className={cn("size-5", className)} {...props}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeOpacity="0.1" />
      <path
        className="status-icon-spin"
        d="M12 2A10 10 0 0 1 22 12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        className="status-icon-spin"
        d="M12 22A10 10 0 0 1 2 12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}
