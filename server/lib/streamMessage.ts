export const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
export const CODEX_IMAGE_ONLY_PROMPT = "Please use the attached image or images as context."

/**
 * Build a Claude stream-json user message from text and optional images.
 * Used by both the new-session spawner and the send-message route.
 */
export function buildStreamMessage(
  message: string | undefined,
  images?: Array<{ data: string; mediaType: string }>
): string {
  const contentBlocks: unknown[] = []
  if (Array.isArray(images)) {
    for (const img of images) {
      const mediaType = ALLOWED_IMAGE_TYPES.has(img.mediaType) ? img.mediaType : "image/png"
      contentBlocks.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: img.data },
      })
    }
  }
  if (message) {
    contentBlocks.push({ type: "text", text: message })
  }
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: contentBlocks },
  })
}
