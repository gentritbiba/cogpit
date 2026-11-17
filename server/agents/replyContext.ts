const EXAMPLE_PATH = process.platform === "win32" ? "C:/Users/me/Pictures/login.png" : "/tmp/login.png"

/** Always in context: how a reply shows the user an image or video. */
export const MEDIA_CONTEXT_APPEND = [
  "Showing media: Cogpit renders Markdown images inline in your replies, and the same syntax plays videos (mp4, m4v, webm, mov).",
  `To show a screenshot, recording or other local image, write \`![short description](<absolute path>)\` in your reply, for example \`![login page](<${EXAMPLE_PATH}>)\`. The angle brackets keep paths with spaces intact.`,
  "A tool result that displays an image to you does not show it to the user. Show milestones and evidence, not every step.",
].join("\n")
