import type { QuestionUnansweredKind, ToolCall, ToolFileDiff } from "./types"

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

const UNANSWERED_KINDS: ReadonlySet<string> = new Set<QuestionUnansweredKind>(["skipped", "replied_in_chat", "dismissed"])

/** The questions an AskUserQuestion answer left unanswered, from the annotations its result echoes. */
function unansweredQuestions(result: Record<string, unknown>): Pick<ToolCall, "unansweredQuestions"> {
  const unanswered: Record<string, QuestionUnansweredKind> = {}
  for (const [question, annotation] of Object.entries(record(result.annotations))) {
    const kind = record(annotation).unanswered
    if (typeof kind === "string" && UNANSWERED_KINDS.has(kind)) unanswered[question] = kind as QuestionUnansweredKind
  }
  return Object.keys(unanswered).length > 0 ? { unansweredQuestions: unanswered } : {}
}

export function toolResultMetadata(name: string, value: unknown): Pick<ToolCall, "awaitingReview" | "fileDiffs" | "additionalFileDiffs" | "unansweredQuestions"> {
  const result = record(value)
  if (name === "Edit" || name === "Write") {
    return result.staged === true ? { awaitingReview: true } : {}
  }
  if (name === "AskUserQuestion") return unansweredQuestions(result)
  if (name !== "Bash") return {}
  const diff = record(result.bashEditDiff)
  if (!Array.isArray(diff.files)) return {}
  const files: ToolFileDiff[] = []
  for (const raw of diff.files) {
    const file = record(raw)
    if (typeof file.filePath !== "string" || !file.filePath || !Array.isArray(file.hunks)) continue
    const hunks: ToolFileDiff["hunks"] = []
    for (const rawHunk of file.hunks) {
      const hunk = record(rawHunk)
      const { oldStart, oldLines, newStart, newLines, lines } = hunk
      if (![oldStart, oldLines, newStart, newLines].every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0)) continue
      if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string" && /^[ +\\-]/.test(line))) continue
      hunks.push({ oldStart: oldStart as number, oldLines: oldLines as number, newStart: newStart as number, newLines: newLines as number, lines })
    }
    if (hunks.length) files.push({ filePath: file.filePath, hunks })
  }
  const more = typeof diff.moreFiles === "number" && Number.isInteger(diff.moreFiles) && diff.moreFiles > 0 ? diff.moreFiles : 0
  return { fileDiffs: files, ...(more ? { additionalFileDiffs: more } : {}) }
}

export function formatToolFileDiff(file: ToolFileDiff): string {
  return file.hunks.map((hunk) => [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...hunk.lines,
  ].join("\n")).join("\n")
}

export function toolDiffEdits(files: readonly ToolFileDiff[]): Array<{
  filePath: string
  oldString: string
  newString: string
  diffLineCounts: { add: number; del: number }
}> {
  return files.map((file) => {
    let oldString = ""
    let newString = ""
    const diffLineCounts = { add: 0, del: 0 }
    for (const hunk of file.hunks) {
      let previousPrefix = ""
      for (const line of hunk.lines) {
        const prefix = line[0]
        if (line === "\\ No newline at end of file") {
          if (previousPrefix === " " || previousPrefix === "-") oldString = oldString.slice(0, -1)
          if (previousPrefix === " " || previousPrefix === "+") newString = newString.slice(0, -1)
        } else {
          const content = line.slice(1) + "\n"
          if (prefix === " " || prefix === "-") oldString += content
          if (prefix === " " || prefix === "+") newString += content
          if (prefix === "+") diffLineCounts.add++
          if (prefix === "-") diffLineCounts.del++
        }
        previousPrefix = prefix
      }
    }
    return { filePath: file.filePath, oldString, newString, diffLineCounts }
  })
}
