import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "rounded-md bg-muted motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200 motion-safe:ease-out motion-reduce:animate-none",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
