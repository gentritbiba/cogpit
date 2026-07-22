import { createContext, useCallback, useContext, useMemo, useState } from "react"
import type { ReactNode } from "react"
import type { Turn } from "@/lib/types"
import { getUserMessageImages } from "@/lib/parser"
import { useSessionContext } from "@/contexts/SessionContext"
import { ImageViewer, type ImageViewerItem } from "./ImageViewer"

interface ImageGalleryContextValue {
  openImage: (image: Omit<ImageViewerItem, "id"> & { id?: string }) => void
}

const ImageGalleryContext = createContext<ImageGalleryContextValue | null>(null)

export function collectSessionImageItems(turns: Turn[]): ImageViewerItem[] {
  const items: ImageViewerItem[] = []

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex]
    const images = getUserMessageImages(turn.userMessage)
    for (let imageIndex = 0; imageIndex < images.length; imageIndex += 1) {
      const image = images[imageIndex]
      items.push({
        id: `${turn.id}:attachment:${imageIndex}`,
        src: `data:${image.source.media_type};base64,${image.source.data}`,
        alt: `Attachment ${imageIndex + 1} from turn ${turnIndex + 1}`,
        label: `Turn ${turnIndex + 1} · Image ${imageIndex + 1}`,
      })
    }
  }

  return items
}

export function ImageGalleryProvider({
  images,
  children,
}: {
  images: ImageViewerItem[]
  children: ReactNode
}): React.ReactElement {
  const [activeViewer, setActiveViewer] = useState<{
    key: number
    images: ImageViewerItem[]
    index: number
  } | null>(null)

  const openImage = useCallback((image: Omit<ImageViewerItem, "id"> & { id?: string }) => {
    const existingIndex = images.findIndex((candidate) => candidate.src === image.src)
    const viewerImages = existingIndex >= 0
      ? images
      : [...images, { ...image, id: image.id ?? `supplemental-image-${images.length}` }]
    setActiveViewer((current) => ({
      key: (current?.key ?? 0) + 1,
      images: viewerImages,
      index: existingIndex >= 0 ? existingIndex : viewerImages.length - 1,
    }))
  }, [images])

  const value = useMemo(() => ({ openImage }), [openImage])

  return (
    <ImageGalleryContext.Provider value={value}>
      {children}
      {activeViewer && (
        <ImageViewer
          key={activeViewer.key}
          images={activeViewer.images}
          initialIndex={activeViewer.index}
          onClose={() => setActiveViewer(null)}
        />
      )}
    </ImageGalleryContext.Provider>
  )
}

export function SessionImageGalleryProvider({ children }: { children: ReactNode }): React.ReactElement {
  const { session } = useSessionContext()
  const images = useMemo(
    () => collectSessionImageItems(session?.turns ?? []),
    [session?.turns],
  )
  return <ImageGalleryProvider images={images}>{children}</ImageGalleryProvider>
}

export function useOptionalImageGallery(): ImageGalleryContextValue | null {
  return useContext(ImageGalleryContext)
}
