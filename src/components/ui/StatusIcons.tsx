import { cn } from "@/lib/utils"
import type { ComponentProps } from "react"

type IconProps = ComponentProps<"svg">

export function ThinkingIcon({ className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" className={cn("size-5", className)} {...props}>
      <circle cx="12" cy="12" r="4" fill="currentColor">
        <animate attributeName="opacity" values="1;0.5;1" dur="2s" repeatCount="indefinite" />
      </circle>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeOpacity="0.2">
        <animate attributeName="r" values="4;10" dur="2s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.8;0" dur="2s" repeatCount="indefinite" />
      </circle>
    </svg>
  )
}

export function ToolUseIcon({ className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" className={cn("size-5", className)} {...props}>
      <path
        d="M12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15Z"
        fill="currentColor"
        fillOpacity="0.5"
      />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="4s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  )
}

export function ProcessingIcon({ className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" className={cn("size-5", className)} {...props}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeOpacity="0.2" />
      <path
        d="M12 2A10 10 0 0 1 22 12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="1s"
            repeatCount="indefinite"
        />
      </path>
    </svg>
  )
}

export function CompactingIcon({ className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" className={cn("size-5", className)} {...props}>
      <path d="M4 12L20 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="4 4" opacity="0.5" />
      <path d="M12 2V8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
         <animate attributeName="d" values="M12 2V8;M12 5V11;M12 2V8" dur="2s" repeatCount="indefinite" />
      </path>
      <path d="M9 5L12 8L15 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <animate attributeName="d" values="M9 5L12 8L15 5;M9 8L12 11L15 8;M9 5L12 8L15 5" dur="2s" repeatCount="indefinite" />
      </path>

      <path d="M12 22V16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
           <animate attributeName="d" values="M12 22V16;M12 19V13;M12 22V16" dur="2s" repeatCount="indefinite" />
      </path>
      <path d="M9 19L12 16L15 19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
           <animate attributeName="d" values="M9 19L12 16L15 19;M9 16L12 13L15 16;M9 19L12 16L15 19" dur="2s" repeatCount="indefinite" />
      </path>
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
        d="M20 6L9 17L4 12"
        strokeDasharray="24"
        strokeDashoffset="24"
      >
        <animate
          attributeName="stroke-dashoffset"
          from="24"
          to="0"
          dur="0.6s"
          fill="freeze"
          calcMode="spline"
          keyTimes="0;1"
          keySplines="0.25 0.1 0.25 1"
        />
      </path>
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
        d="M12 2A10 10 0 0 1 22 12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
         <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="1.5s"
            repeatCount="indefinite"
        />
      </path>
      <path
        d="M12 22A10 10 0 0 1 2 12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
         <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="1.5s"
            repeatCount="indefinite"
        />
      </path>
    </svg>
  )
}
