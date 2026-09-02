export interface CommandSection {
  /** Text after `---` in the echo marker; empty for a bare `echo ---`. */
  label: string
  command: string
  /** Output between this section's marker and the next; null when the result never reached it. */
  output: string | null
}

const MARKER_RE = /(?:^|;|&&)\s*echo\s+(["']?)---([\w.-]*)\1\s*(?=;|&&|$)/g

function stripSeparator(text: string): string {
  return text.replace(/^\s*(?:;|&&)/, "").trim()
}

/**
 * Agents batch independent reads into one Bash call as
 * `echo ---LABEL; cmd; echo ---LABEL2; cmd2 …` so the flat output stays
 * attributable. Recover that structure; null when the command is not shaped
 * that way, or when the output never echoed the markers back (an error string
 * in place of stdout) and the plain result well is the honest view.
 */
export function parseSectionedCommand(
  command: string,
  result: string | null,
): CommandSection[] | null {
  // chunk 0 is output before the first marker; chunk i+1 follows marker i.
  const parts: Array<{ label: string; command: string; chunk: number }> = []
  const markers: string[] = []
  let cursor = 0

  for (const match of command.matchAll(MARKER_RE)) {
    const before = stripSeparator(command.slice(cursor, match.index))
    if (before) parts.push({ label: markers.at(-1) ?? "", command: before, chunk: markers.length })
    markers.push(match[2])
    cursor = match.index + match[0].length
  }
  if (markers.length === 0) return null
  const tail = stripSeparator(command.slice(cursor))
  if (tail) parts.push({ label: markers.at(-1) ?? "", command: tail, chunk: markers.length })
  if (parts.length < 2) return null

  const chunks = result === null ? null : splitOutput(result, markers)
  if (chunks !== null && chunks.length < 2) return null
  return parts.map(({ chunk, ...part }) => ({
    ...part,
    output: chunks !== null && chunk < chunks.length ? chunks[chunk] : null,
  }))
}

function splitOutput(result: string, markers: string[]): string[] {
  const chunks: string[][] = [[]]
  let expected = 0
  for (const line of result.split(/\r\n|\r|\n/)) {
    if (expected < markers.length && line === `---${markers[expected]}`) {
      chunks.push([])
      expected++
    } else {
      chunks[chunks.length - 1].push(line)
    }
  }
  return chunks.map((lines) => lines.join("\n").trim())
}

export type SectionKind = "read" | "search" | "list" | "run" | "write"

export interface SectionAnalysis {
  kind: SectionKind
  /** Path-shaped tokens in the command, in order of appearance, deduplicated. */
  paths: string[]
  /** The one file a plain `cat`/`head`/`tail`/`sed -n` section prints, if that is all it does. */
  readFile: { path: string; from?: number; to?: number } | null
  /** Output carries a shell-level failure the `;` chain would have swallowed. */
  failed: boolean
}

const WRITE_HEADS = new Set([
  "mv", "cp", "rm", "mkdir", "touch", "tee", "ln", "chmod", "chown", "install", "rsync",
])
const REDIRECT_RE = /(?:^|[^\d&])>{1,2}(?!\s*&|\s*\/dev\/null)/
const SEGMENT_SPLIT_RE = /\|\||&&|[|;\n]/
const NEUTRAL_HEADS = new Set(["echo", "printf", "true", "false", ":"])
const SEARCH_HEADS = new Set(["find", "grep", "rg", "ag", "ack", "locate", "which", "whereis"])
const READ_HEADS = new Set([
  "cat", "head", "tail", "less", "more", "wc", "stat", "file", "strings", "jq", "awk", "cut",
  "sort", "uniq", "tr", "sed", "diff", "xxd", "od",
])
const LIST_HEADS = new Set(["ls", "tree", "du"])

const WRAPPER_HEADS = new Set(["xargs", "sudo", "env", "time", "nohup", "command"])

function isWriteSegment(segment: string): boolean {
  const words = segment.split(/\s+/)
  while (words.length > 1 && (WRAPPER_HEADS.has(words[0]) || /^-/.test(words[0]))) words.shift()
  const [head, ...rest] = words
  if (WRITE_HEADS.has(head)) return true
  if (head === "sed" && rest.some((arg) => /^-[a-zA-Z]*i/.test(arg))) return true
  if (/^python3?$/.test(head) && rest[0] === "-") return true
  if (head === "git" && /^(add|commit|checkout|reset|push|stash|rebase|merge|rm|mv)$/.test(rest[0] ?? "")) return true
  return REDIRECT_RE.test(segment)
}

const HEREDOC_RE = /<<-?\s*['"]?\w+['"]?/
const QUOTED_RE = /'[^']*'|"(?:[^"\\]|\\.)*"/g

/** Simple commands of a shell line: quoted strings and heredoc bodies are data, not syntax. */
function shellSegments(command: string): string[] {
  return command
    .split(HEREDOC_RE)[0]
    .replace(QUOTED_RE, '""')
    .split(SEGMENT_SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function classifySection(command: string): SectionKind {
  const segments = shellSegments(command)
  if (segments.some(isWriteSegment)) return "write"
  let search = false
  let read = false
  let list = false
  for (const segment of segments) {
    const word = segment.split(/\s+/)[0]
    if (!word || NEUTRAL_HEADS.has(word)) continue
    if (SEARCH_HEADS.has(word)) search = true
    else if (READ_HEADS.has(word)) read = true
    else if (LIST_HEADS.has(word)) list = true
    else return "run"
  }
  if (list) return "list"
  if (search) return "search"
  if (read) return "read"
  return "run"
}

const PATH_TOKEN_RE = /^["']?((?:~|\.{1,2})?\/?[\w.@+-]+(?:\/[\w.@+*{}-]+)+\/?|[\w@+-]+\.(?:[cm]?[jt]sx?|json|md|mdx|py|rb|go|rs|sh|zsh|ya?ml|toml|css|scss|html|txt|sql|swift|kt|java|plist|lock))["']?[,:;]?$/

export function extractPaths(command: string): string[] {
  const seen = new Set<string>()
  for (const token of command.split(HEREDOC_RE)[0].split(/\s+/)) {
    const match = token.match(PATH_TOKEN_RE)
    if (!match) continue
    const path = match[1]
    if (path.includes("*") || path.includes("{") || path.startsWith("-")) continue
    seen.add(path)
  }
  return [...seen]
}

const READ_FILE_RE = /^(?:cat|head(?:\s+-n?\s*\d+)?|tail(?:\s+-n?\s*\d+)?|sed\s+-n\s+(\d+),(\d+)p)\s+(["']?)(\S+)\3(?:\s*\|\s*(?:head|tail)(?:\s+-n?\s*\d+)?)?$/

export function readFileTarget(command: string): SectionAnalysis["readFile"] {
  const match = command.trim().match(READ_FILE_RE)
  if (!match) return null
  const [, from, to, , path] = match
  if (!extractPaths(path).length) return null
  return from ? { path, from: Number(from), to: Number(to) } : { path }
}

// Shell-level signatures only: a printed source file legitimately contains
// "error:" but never one of these.
const FAILURE_RE = /(?:No such file or directory|command not found|no matches found|Permission denied|is not recognized as an internal|Traceback \(most recent call last\)|^fatal: |^npm ERR!|^error: |^ERROR: |exited with code [1-9]\d*|^FAIL\b)/m

export function detectFailure(kind: SectionKind, output: string | null): boolean {
  if (!output) return false
  // A file being read may mention any of these; a missing file says so in a line or two.
  if (kind === "read" && output.split("\n").length > 3) return false
  return FAILURE_RE.test(output)
}

export function analyzeSection(section: CommandSection): SectionAnalysis {
  const kind = classifySection(section.command)
  return {
    kind,
    paths: extractPaths(section.command),
    readFile: kind === "read" ? readFileTarget(section.command) : null,
    failed: detectFailure(kind, section.output),
  }
}
