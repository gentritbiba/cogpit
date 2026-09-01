import type { ImageAttachment } from "../sdk-session"

export const COPILOT_IMAGE_ONLY_PROMPT = "Describe the attached image(s)."

export function buildCopilotAttachments(
  images?: ImageAttachment[],
): Array<{ type: "blob"; data: string; mimeType: string; displayName: string }> | undefined {
  if (!images?.length) return undefined
  return images.map((image, index) => ({
    type: "blob",
    data: image.data,
    mimeType: image.mediaType,
    displayName: `image-${index + 1}`,
  }))
}
