import { cn } from "@/lib/utils"
import type { ComponentProps } from "react"

type IconProps = ComponentProps<"svg">

export function ThinkingIcon({ className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" className={cn("size-5", className)} {...props}>
      <circle className="status-icon-thinking-core" cx="12" cy="12" r="4" fill="currentColor" />
      <circle className="status-icon-thinking-ring" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}

export function ToolUseIcon({ className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" className={cn("size-5", className)} {...props}>
      {/* Terminal cursor block */}
      <rect x="4" y="4" width="16" height="16" rx="3" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.3" />
      {/* Prompt chevron */}
      <path d="M8 10L11 12.5L8 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {/* Blinking cursor line */}
      <line className="status-icon-cursor" x1="13" y1="15" x2="17" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

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

export function CompactingIcon({ className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" className={cn("size-5", className)} {...props}>
      <path d="M4 12L20 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="4 4" opacity="0.5" />
      <g className="status-icon-compact-top">
        <path d="M12 2V8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M9 5L12 8L15 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <g className="status-icon-compact-bottom">
        <path d="M12 22V16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M9 19L12 16L15 19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </g>
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
