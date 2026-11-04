import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { attachmentSrc, type UploadedImage } from "./useImageUpload"

/** The images a draft carries, each with a button that removes it. */
export function ImageThumbnails({
  images,
  onRemove,
  altFor = (_, index) => `Upload ${index + 1}`,
}: {
  images: readonly UploadedImage[]
  onRemove: (image: UploadedImage, index: number) => void
  altFor?: (image: UploadedImage, index: number) => string
}) {
  if (images.length === 0) return null
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {images.map((image, index) => (
        <div key={image.id} className="motion-list-item relative group/thumb">
          <img src={attachmentSrc(image)} alt={altFor(image, index)} className="h-16 w-auto rounded-md border bg-muted object-contain" />
          <Button type="button" variant="ghost" size="icon-xs" onClick={() => onRemove(image, index)} className="absolute -right-1.5 -top-1.5 size-5 rounded-full border bg-popover p-0 text-muted-foreground opacity-100 hover:bg-destructive hover:text-destructive-foreground sm:opacity-0 sm:group-hover/thumb:opacity-100 sm:focus-visible:opacity-100" aria-label={`Remove image ${index + 1}`}>
            <X className="size-3" data-icon="icon" />
          </Button>
        </div>
      ))}
    </div>
  )
}

/** Why images could not be attached or sent; without `onDismiss` it stays until the cause is fixed. */
export function ImageNotice({ message, onDismiss }: { message: string | null; onDismiss?: () => void }) {
  if (!message) return null
  return (
    <div role="status" aria-live="polite" className="motion-enter mb-2 flex items-center gap-2 text-xs text-warning">
      <span className="flex-1">{message}</span>
      {onDismiss && (
        <Button type="button" variant="ghost" size="icon-xs" onClick={onDismiss} className="text-muted-foreground" aria-label="Dismiss image notice">
          <X data-icon="icon" />
        </Button>
      )}
    </div>
  )
}

export function ImageDropOverlay() {
  return (
    <div className="motion-enter pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg border-2 border-dashed border-info/40 bg-info/10">
      <span className="text-sm font-medium text-info">Drop images here</span>
    </div>
  )
}
