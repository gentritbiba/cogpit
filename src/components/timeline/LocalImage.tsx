import { useState } from "react"
import { Maximize2 } from "lucide-react"
import { authUrl } from "@/lib/auth"
import { cn } from "@/lib/utils"
import { ImageViewer, type ImageViewerItem } from "./ImageViewer"
import { useOptionalImageGallery } from "./SessionImageGallery"
import { useCapability } from "@/hooks/useCapability"
import { Button } from "@/components/ui/button"

export const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif",
])

/** True when the path ends in an extension the image proxy can serve. */
export function hasImageExtension(path: string | undefined): boolean {
  if (!path) return false
  const dot = path.lastIndexOf(".")
  if (dot === -1) return false
  return IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase())
}

/** True when the src looks like a local absolute file path to an image */
export function isLocalImagePath(src: string | undefined): boolean {
  if (!src) return false
  if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("data:")) return false
  if (!src.startsWith("/")) return false
  return hasImageExtension(src)
}

/**
 * Rewrite local image paths to go through the API proxy. `authUrl` applies the
 * active device prefix and appends the auth token for remote clients — fixing a
 * pre-existing bug where remote <img> loads were token-less (and so 401'd) and
 * routing the request to the active device via the hub proxy. Only the proxy
 * URL is wrapped; external/data URLs pass through untouched so the token is
 * never leaked to a third-party host.
 */
export function resolveImageSrc(src: string | undefined): string | undefined {
  if (!src) return src
  if (isLocalImagePath(src)) return authUrl(`/api/local-file?path=${encodeURIComponent(src)}`)
  return src
}

/**
 * Image component that proxies local file paths through /api/local-file
 * and supports click-to-expand in a dialog.
 */
export function LocalImage({
  src,
  alt,
  id = "markdown-image",
  className,
  thumbnailClassName,
}: {
  src?: string
  alt?: string
  id?: string
  className?: string
  thumbnailClassName?: string
}): React.ReactElement | null {
  const canAccessHostFiles = useCapability("hostFiles")
  const [expanded, setExpanded] = useState(false)
  const [hasOpened, setHasOpened] = useState(false)
  const [failedSrc, setFailedSrc] = useState<string | undefined>()
  const imageGallery = useOptionalImageGallery()
  const localImageBlocked = isLocalImagePath(src) && !canAccessHostFiles
  const resolved = localImageBlocked ? undefined : resolveImageSrc(src)
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
        <img
          src={resolved}
          alt={alt ?? ""}
          loading="lazy"
          decoding="async"
          onError={() => setFailedSrc(resolved)}
          className={cn("max-h-96 max-w-full rounded-lg object-contain", thumbnailClassName)}
        />
        <span className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-md border border-white/10 bg-black/45 text-white/70 opacity-80 backdrop-blur transition-[color,background-color,opacity] group-hover/image:bg-black/65 group-hover/image:text-white sm:opacity-0 sm:group-hover/image:opacity-100 sm:group-focus-visible/image:opacity-100">
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
