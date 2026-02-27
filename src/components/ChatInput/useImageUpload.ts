import { useState, useCallback } from "react"

export interface UploadedImage {
  file: File
  preview: string
  data: string
  mediaType: string
}

export function useImageUpload() {
  const [images, setImages] = useState<UploadedImage[]>([])
  const [isDragOver, setIsDragOver] = useState(false)

  const addImageFiles = useCallback((files: FileList | File[]) => {
    const SUPPORTED_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"))
    for (const file of imageFiles) {
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        if (SUPPORTED_TYPES.has(file.type)) {
          const base64 = dataUrl.split(",")[1]
          setImages((prev) => [
            ...prev,
            { file, preview: dataUrl, data: base64, mediaType: file.type },
          ])
        } else {
          // Convert unsupported types (e.g. TIFF from macOS screenshots) to PNG via canvas
          const img = new Image()
          img.onload = () => {
            const canvas = document.createElement("canvas")
            canvas.width = img.width
            canvas.height = img.height
            const ctx = canvas.getContext("2d")
            if (!ctx) return
            ctx.drawImage(img, 0, 0)
            const pngDataUrl = canvas.toDataURL("image/png")
            const pngBase64 = pngDataUrl.split(",")[1]
            setImages((prev) => [
              ...prev,
              { file, preview: pngDataUrl, data: pngBase64, mediaType: "image/png" },
            ])
          }
          img.src = dataUrl
        }
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
    addImageFiles,
    removeImage,
    clearImages,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handlePaste,
  }
}
