import { useState } from "react"
import { cn } from "@/lib/utils"
import { useCapability } from "@/hooks/useCapability"
import { isLocalVideoPath, resolveMediaSrc } from "./localMedia"

/**
 * Inline video player that proxies local file paths through /api/local-file.
 * The proxy serves byte ranges, so seeking works on long recordings.
 */
export function LocalVideo({
  src,
  alt,
  className,
}: {
  src?: string
  alt?: string
  className?: string
}): React.ReactElement | null {
  const canAccessHostFiles = useCapability("hostFiles")
  const [failedSrc, setFailedSrc] = useState<string | undefined>()
  const blocked = isLocalVideoPath(src) && !canAccessHostFiles
  const resolved = blocked ? undefined : resolveMediaSrc(src)

  if (!resolved) {
    return alt ? <span className="text-muted-foreground">{alt}</span> : null
  }

  if (failedSrc === resolved) {
    return (
      <span role="status" className="my-3 block text-xs text-muted-foreground">
        Video unavailable{alt ? `: ${alt}` : ""}
      </span>
    )
  }

  return (
    <span
      className={cn(
        "my-3 block w-fit max-w-full overflow-hidden rounded-lg border border-border bg-background p-1",
        className,
      )}
    >
      <video
        src={resolved}
        controls
        playsInline
        preload="metadata"
        aria-label={alt || "Rendered video"}
        onError={() => setFailedSrc(resolved)}
        className="block max-h-96 max-w-full rounded-lg bg-black"
      />
    </span>
  )
}
