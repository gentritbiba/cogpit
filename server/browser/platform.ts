export function browserUnsupportedReason(platform: NodeJS.Platform = process.platform): string | null {
  return platform === "win32"
    ? "The Browser panel is not supported on native Windows yet. Use Cogpit on macOS or Linux to host a managed browser."
    : null
}
