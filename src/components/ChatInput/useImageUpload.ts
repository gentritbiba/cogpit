import { useState, useCallback } from "react"

interface UploadedImage {
  file: File
  preview: string
  data: string
  mediaType: string
}

const MAX_DIMENSION = 1568
const JPEG_QUALITY = 0.85
const MAX_BYTES = 3_500_000 // ~3.5MB base64 limit

function compressImage(img: HTMLImageElement, sourceType: string): { dataUrl: string; base64: string; mediaType: string } {
  let { width, height } = img
  const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height))
  width = Math.round(width * scale)
  height = Math.round(height * scale)

  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")!
  ctx.drawImage(img, 0, 0, width, height)

  // Use JPEG for photos (jpeg/webp), PNG for images that may have transparency
  const useJpeg = sourceType === "image/jpeg" || sourceType === "image/webp"
  const outputType = useJpeg ? "image/jpeg" : "image/png"

  let dataUrl = canvas.toDataURL(outputType, useJpeg ? JPEG_QUALITY : undefined)
  let base64 = dataUrl.split(",")[1]

  // If still too large, progressively reduce quality
  if (base64.length > MAX_BYTES) {
    let quality = useJpeg ? 0.7 : 0.8
    while (base64.length > MAX_BYTES && quality > 0.3) {
      dataUrl = canvas.toDataURL("image/jpeg", quality)
      base64 = dataUrl.split(",")[1]
      quality -= 0.1
    }
    return { dataUrl, base64, mediaType: "image/jpeg" }
  }

  return { dataUrl, base64, mediaType: outputType }
}

export function useImageUpload() {
  const [images, setImages] = useState<UploadedImage[]>([])
  const [isDragOver, setIsDragOver] = useState(false)

  const addImageFiles = useCallback((files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"))
    for (const file of imageFiles) {
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        const img = new Image()
        img.onload = () => {
          const compressed = compressImage(img, file.type)
          setImages((prev) => [
            ...prev,
            { file, preview: compressed.dataUrl, data: compressed.base64, mediaType: compressed.mediaType },
          ])
        }
        img.src = dataUrl
      }
      reader.onerror = () => {
        console.warn(`Failed to read image file: ${file.name}`)
      }
      reader.readAsDataURL(file)
    }
  }, [])

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const clearImages = useCallback(() => {
    setImages([])
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false)
    }
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)
      if (e.dataTransfer.files.length > 0) {
        addImageFiles(e.dataTransfer.files)
      }
    },
    [addImageFiles]
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      const imageItems = Array.from(items).filter((item) => item.type.startsWith("image/"))
      if (imageItems.length === 0) return
      e.preventDefault()
      const files = imageItems.map((item) => item.getAsFile()).filter(Boolean) as File[]
      addImageFiles(files)
    },
    [addImageFiles]
  )

  return {
    images,
    isDragOver,
    removeImage,
    clearImages,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handlePaste,
  }
}
