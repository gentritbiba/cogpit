/**
 * The first line of markdown worth reading as plain text: headings, list
 * markers, emphasis, code ticks and table rules are dropped, and lines that
 * are only markup are skipped.
 */
export function previewLine(markdown: string, max = 200): string {
  for (const raw of markdown.split("\n")) {
    const line = raw
      .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|\*|_|`+|~~)(.+?)\1/g, "$2")
      .replace(/\s*\|\s*/g, " · ")
      .replace(/^[\s·]+|[\s·]+$/g, "")
      .trim()
    if (!line || /^[-=:·\s]+$/.test(line) || /^(?:```|~~~)/.test(raw.trim())) continue
    return line.length > max ? `${line.slice(0, max - 1)}…` : line
  }
  return ""
}
