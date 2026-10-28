/**
 * Markdown, as agents write it, to Slack mrkdwn. Code, links and Slack's own
 * `<@U…>` entities are set aside first so the emphasis rules cannot touch them.
 */
export function toMrkdwn(markdown: string): string {
  const stash: string[] = []
  const hold = (value: string) => `\uE000${stash.push(value) - 1}\uE001`
  let text = markdown
  text = text.replace(/```(?:[^\n]*\n)?[\s\S]*?```/g, (block) => hold(block.replace(/^```[^\n]*\n/, "```\n")))
  text = text.replace(/`[^`\n]+`/g, hold)
  text = text.replace(/(?<!!)\[([^\]]+)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)/g, (_, label: string, url: string) => hold(`<${url.replace(/^<|>$/g, "")}|${label}>`))
  text = text.replace(/<(?:[@#!]|(?:https?|mailto|tel):)[^>\n]+>/g, hold)
  text = text.replace(/^(>+\s)/gm, hold)
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  text = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_, heading: string) => hold(`*${heading.trim().replace(/\*\*(.+?)\*\*/g, "$1")}*`))
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, (_, inner: string) => hold(`*_${inner}_*`))
  text = text.replace(/\*\*(.+?)\*\*/g, (_, inner: string) => hold(`*${inner}*`))
  text = text.replace(/(?<!\*)\*(\S(?:[^*\n]*?\S)?)\*(?!\*)/g, (_, inner: string) => hold(`_${inner}_`))
  text = text.replace(/~~(.+?)~~/g, (_, inner: string) => hold(`~${inner}~`))
  // Restoring can surface another placeholder (a link inside a heading), so repeat until none is left.
  for (let pass = 0; pass < 5 && text.includes("\uE000"); pass++) text = text.replace(/\uE000(\d+)\uE001/g, (_, index: string) => stash[Number(index)])
  return text
}

/** Slack truncates past 40,000 characters; split earlier, on paragraphs, keeping code fences balanced. */
export function chunkMessage(text: string, limit = 3_900): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit)
    if (cut < limit / 2) cut = rest.lastIndexOf("\n", limit)
    if (cut < limit / 2) cut = limit
    let chunk = rest.slice(0, cut)
    rest = rest.slice(cut).replace(/^\n+/, "")
    if ((chunk.match(/```/g)?.length ?? 0) % 2 === 1) {
      chunk += "\n```"
      rest = "```\n" + rest
    }
    chunks.push(chunk)
  }
  if (rest) chunks.push(rest)
  return chunks.length > 1 ? chunks.map((chunk, index) => `${chunk}\n_(${index + 1}/${chunks.length})_`) : chunks
}
