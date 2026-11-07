import { useState, type CSSProperties } from "react"
import { cn } from "@/lib/utils"
import { knownImageSize, rememberImageSize, type ImageSize } from "./imageSize"

/** The box an image of unknown size holds until it loads: a screenshot's shape at the height cap. */
const PLACEHOLDER_RATIO = 4 / 3

/**
 * An image that holds its final box from the first frame, so loading never
 * changes the height of the row around it. With a known size the box is
 * exact; otherwise it holds a placeholder box until the image loads, and the
 * size it loads at is remembered for the next mount.
 */
export function ReservedImage({
  src,
  alt,
  maxHeightRem,
  className,
  onError,
}: {
  src: string | undefined
  alt: string
  /** The height cap, in rem. */
  maxHeightRem: number
  className?: string
  onError?: () => void
}): React.ReactElement {
  const [loaded, setLoaded] = useState<{ src: string; size: ImageSize } | null>(null)
  const size = (loaded && loaded.src === src ? loaded.size : null) ?? knownImageSize(src)
  const style: CSSProperties = size
    ? { width: `min(${size.width}px, ${maxHeightRem * size.width / size.height}rem)`, aspectRatio: `${size.width} / ${size.height}` }
    : { width: `${maxHeightRem * PLACEHOLDER_RATIO}rem`, height: `${maxHeightRem}rem` }

  return (
    <span data-image-box="" className={cn("block max-w-full overflow-hidden", !size && "bg-muted/40", className)} style={style}>
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onError={onError}
        onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget
          if (!src || !naturalWidth || !naturalHeight) return
          rememberImageSize(src, naturalWidth, naturalHeight)
          if (!size || size.width !== naturalWidth || size.height !== naturalHeight) {
            setLoaded({ src, size: { width: naturalWidth, height: naturalHeight } })
          }
        }}
        className="block size-full object-contain"
      />
    </span>
  )
}
