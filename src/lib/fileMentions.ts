export interface FileMention {
  start: number
  query: string
}

export function findFileMention(text: string): FileMention | null {
  const match = /(?:^|\s)@([^\s]*)$/.exec(text)
  if (!match || match.index === undefined) return null
  const atOffset = match[0].lastIndexOf("@")
  return {
    start: match.index + atOffset,
    query: match[1] ?? "",
  }
}

export function replaceFileMention(text: string, mention: FileMention, path: string): string {
  return `${text.slice(0, mention.start)}@${path} `
}
