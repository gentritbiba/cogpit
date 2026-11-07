import { useState } from "react"
import { Maximize2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { ImageViewer, type ImageViewerItem } from "./ImageViewer"
import { useOptionalImageGallery } from "./SessionImageGallery"
import { useCapability } from "@/hooks/useCapability"
import { isLocalImagePath, resolveMediaSrc } from "./localMedia"
import { Button } from "@/components/ui/button"
import { ReservedImage } from "./ReservedImage"

/**
 * Image component that proxies local file paths through /api/local-file
 * and supports click-to-expand in a dialog.
 */
export function LocalImage({
  src,
  alt,
  id = "markdown-image",
  className,
  maxHeightRem = 24,
}: {
  src?: string
  alt?: string
  id?: string
  className?: string
  /** The thumbnail's height cap, in rem. */
  maxHeightRem?: number
}): React.ReactElement | null {
  const canAccessHostFiles = useCapability("hostFiles")
  const [expanded, setExpanded] = useState(false)
  const [hasOpened, setHasOpened] = useState(false)
  const [failedSrc, setFailedSrc] = useState<string | undefined>()
  const imageGallery = useOptionalImageGallery()
  const localImageBlocked = isLocalImagePath(src) && !canAccessHostFiles
  const resolved = localImageBlocked ? undefined : resolveMediaSrc(src)
  const viewerImage: ImageViewerItem | null = resolved
    ? { id, src: resolved, alt: alt ?? "Rendered image", label: alt || "Rendered image" }
    : null

  const openImage = () => {
    if (!viewerImage) return
    if (imageGallery) {
      imageGallery.openImage(viewerImage)
    } else {
      setHasOpened(true)
      setExpanded(true)
    }
  }

  if (localImageBlocked) {
    return alt ? <span className="text-muted-foreground">{alt}</span> : null
  }

  if (resolved && failedSrc === resolved) {
    return (
      <span role="status" className="my-3 block text-xs text-muted-foreground">
        Image unavailable{alt ? `: ${alt}` : ""}
      </span>
    )
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        onClick={openImage}
        aria-label={`Open ${alt || "rendered image"}`}
        className={cn(
          "group/image relative my-3 block h-auto max-w-full overflow-hidden rounded-lg border border-border bg-background p-1 transition-colors hover:bg-muted focus-visible:ring-ring/40",
          className,
        )}
      >
        <ReservedImage
          src={resolved}
          alt={alt ?? ""}
          maxHeightRem={maxHeightRem}
          onError={() => setFailedSrc(resolved)}
          className="rounded-lg"
        />
        <span className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-md border border-border bg-popover text-foreground/70 opacity-80 backdrop-blur transition-[color,opacity] group-hover/image:text-foreground sm:opacity-0 sm:group-hover/image:opacity-100 sm:group-focus-visible/image:opacity-100">
          <Maximize2 className="size-3.5" data-icon="icon" />
        </span>
      </Button>
      {hasOpened && viewerImage && (
        <ImageViewer
          open={expanded}
          images={[viewerImage]}
          initialIndex={0}
          onClose={() => setExpanded(false)}
          onCloseComplete={() => setHasOpened(false)}
        />
      )}
    </>
  )
}
