import { useState, useCallback, useEffect, useRef } from "react"
import { MAX_ATTACHMENT_BYTES } from "./draftStore"
import type { ComposerAttachment } from "../../../shared/session/composerContext"

/** An attached image as the draft holds it: its bytes, so the draft can be kept and restored. */
export type UploadedImage = ComposerAttachment

/** Where an attachment's thumbnail reads its bytes from. */
export function attachmentSrc(image: Pick<ComposerAttachment, "mediaType" | "data">): string {
  return `data:${image.mediaType};base64,${image.data}`
}

const MAX_DIMENSION = 1568
const JPEG_QUALITY = 0.85
const MAX_BYTES = MAX_ATTACHMENT_BYTES

function compressImage(img: HTMLImageElement, sourceType: string): { base64: string; mediaType: string } {
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
    return { base64, mediaType: "image/jpeg" }
  }

  return { base64, mediaType: outputType }
}

export function useImageUpload(enabled = true, initial: UploadedImage[] = []) {
  const [images, setImages] = useState<UploadedImage[]>(initial)
  const [uploading, setUploading] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [])
  const [isDragOver, setIsDragOver] = useState(false)
  const [unsupportedAttempt, setUnsupportedAttempt] = useState(false)
  const enabledRef = useRef(enabled)

  useEffect(() => {
    enabledRef.current = enabled
  }, [enabled])

  const addImageFiles = useCallback((files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"))
    if (!enabled) {
      if (imageFiles.length > 0) setUnsupportedAttempt(true)
      return
    }
    setUnsupportedAttempt(false)
    const token = generation.current
    setUploading((count) => count + imageFiles.length)
    for (const file of imageFiles) {
      let completed = false
      const finish = (message?: string) => {
        if (completed || token !== generation.current) return
        completed = true
        setUploading((count) => Math.max(0, count - 1))
        if (message) setUploadError(message)
      }
      const reader = new FileReader()
      reader.onload = () => {
        if (token !== generation.current) return
        if (!enabledRef.current) {
          setUnsupportedAttempt(true)
          finish("Image loading stopped because this model does not accept images. Reattach it after switching models.")
          return
        }
        const dataUrl = reader.result as string
        const img = new Image()
        img.onload = () => {
          if (token !== generation.current) return
          if (!enabledRef.current) {
            setUnsupportedAttempt(true)
            finish("Image loading stopped because this model does not accept images. Reattach it after switching models.")
            return
          }
          let compressed: ReturnType<typeof compressImage>
          try { compressed = compressImage(img, file.type) } catch { finish(`Could not process ${file.name}. Reattach the image.`); return }
          if (compressed.base64.length > MAX_BYTES) { finish(`${file.name} is too large after compression (maximum 3.5 MB encoded). Use a smaller image.`); return }
          setImages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), data: compressed.base64, mediaType: compressed.mediaType },
          ])
          finish()
        }
        img.onerror = () => finish(`Could not decode ${file.name}. Reattach a supported image.`)
        img.src = dataUrl
      }
      reader.onerror = () => {
        finish(`Could not read ${file.name}. Reattach the image.`)
      }
      reader.readAsDataURL(file)
    }
  }, [enabled])

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index))
    setUnsupportedAttempt(false)
  }, [])

  const clearImages = useCallback(() => {
    generation.current++
    setUploading(0)
    setUploadError(null)
    setImages([])
    setUnsupportedAttempt(false)
  }, [])

  /** Puts back the images of a send the session refused, unless others were attached since. */
  const restoreImages = useCallback((draft: UploadedImage[]) => {
    setImages((current) => current.length > 0 ? current : draft)
  }, [])

  /** Attaches images that come with a context item, such as a browser capture. */
  const attachImages = useCallback((attachments: UploadedImage[]) => {
    if (attachments.length === 0) return
    if (!enabledRef.current) {
      setUnsupportedAttempt(true)
      return
    }
    setImages((current) => [...current.filter((image) => !attachments.some((added) => added.id === image.id)), ...attachments])
  }, [])

  /** Drops the images a removed context item brought. */
  const removeContextImages = useCallback((contextId: string) => {
    setImages((current) => current.filter((image) => image.contextId !== contextId))
  }, [])

  const dismissImageError = useCallback(() => { setUnsupportedAttempt(false); setUploadError(null) }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (enabled) setIsDragOver(true)
  }, [enabled])

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
    uploading: uploading > 0,
    isDragOver,
    imageError: uploadError ?? (uploading > 0 ? "Loading images… Wait before sending or stashing." : null) ?? (!enabled && images.length > 0
      ? "The selected model does not accept images. Switch models or remove the attachments."
      : !enabled && unsupportedAttempt
        ? "The selected model does not accept the image you tried to add."
        : null),
    hasUnsupportedAttachments: !enabled && images.length > 0,
    dismissImageError,
    removeImage,
    clearImages,
    restoreImages,
    attachImages,
    removeContextImages,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handlePaste,
  }
}
