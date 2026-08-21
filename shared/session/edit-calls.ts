/**
 * Normalizes every way an agent can change a file into the Edit/Write tool
 * shape the file-changes surfaces already understand.
 *
 * Three sources feed in:
 *   - `Edit` / `Write` — passed through untouched.
 *   - `MultiEdit`      — one synthetic Edit per entry in `input.edits`.
 *   - `Bash`           — recovered from the command string, but only for the
 *                        shapes where the resulting content is provably in the
 *                        command itself (quoted heredocs, literal `sed -i`).
 *
 * Claude Code injects a "prefer Bash over the dedicated tools" instruction
 * whenever bypass-permissions or auto mode is active, so in those sessions
 * every edit arrives as an opaque Bash call and the file-changes panel would
 * otherwise render empty.
 *
 * Deliberately display-only: synthetic calls carry `synthesizedFrom` and must
 * never reach the undo engine. Undo reverses a Write by unlinking the file, and
 * a Bash redirect gives us no way to know whether the file existed beforehand.
 */
import type { ToolCall } from "./types"

/** Marks a call this module invented, so undo and stats can skip it. */
const SYNTHESIZED_FROM = "synthesizedFrom"

/** A character that means something beyond itself inside a `sed` pattern. */
const REGEX_METACHAR = /[.*+?[\]{}()^$|]/

/** Shell constructs we cannot resolve, so a path containing one is unusable. */
const UNRESOLVED_PATH = /[$*?`~]|\\\s/

/**
 * A heredoc declaration with a quoted delimiter: `<<'EOF'`, `<<-"EOF"`.
 * Unquoted `<<EOF` is left out on purpose — the shell expands `$vars` and
 * backticks in that body, so what we can see is not what landed on disk.
 */
const HEREDOC_DECL = /<<(-?)\s*(?:'([^']+)'|"([^"]+)")/
const HEREDOC_DECL_ALL = new RegExp(HEREDOC_DECL, "g")

/** A file change recovered from a Bash command, as Edit/Write tool input. */
interface Recovered {
  name: "Edit" | "Write"
  input: Record<string, unknown>
}

function synthetic(
  from: ToolCall,
  id: string,
  name: "Edit" | "Write",
  input: Record<string, unknown>,
): ToolCall {
  return {
    id,
    name,
    input: { ...input, [SYNTHESIZED_FROM]: from.name },
    result: null,
    isError: false,
    timestamp: from.timestamp,
  }
}

/** True when this call was invented by `expandEditToolCalls`. */
export function isSynthesized(tc: ToolCall): boolean {
  return typeof tc.input[SYNTHESIZED_FROM] === "string"
}

// ── Paths ────────────────────────────────────────────────────────────────────

function unquote(token: string): string {
  const first = token[0]
  if ((first === '"' || first === "'") && token.at(-1) === first) return token.slice(1, -1)
  return token
}

/** Collapses `.` and `..` so one file cannot occupy two rows in the panel. */
function normalizeAbsolute(path: string): string {
  const out: string[] = []
  for (const part of path.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") out.pop()
    else out.push(part)
  }
  return `/${out.join("/")}`
}

/**
 * An absolute, literal path, or null.
 *
 * Relative paths only resolve when the command told us where it was running —
 * either the session cwd or a `cd` earlier in the same command. Without that
 * the same file would appear both as `src/App.tsx` and `/Users/…/src/App.tsx`.
 */
function resolvePath(raw: string, cwd: string | null): string | null {
  const path = unquote(raw.trim())
  if (!path || UNRESOLVED_PATH.test(path)) return null
  if (path.startsWith("/")) return normalizeAbsolute(path)
  if (!cwd) return null
  return normalizeAbsolute(`${cwd}/${path}`)
}

// ── Command structure ────────────────────────────────────────────────────────

interface Segment {
  /** One simple command, e.g. `cat > out.txt <<'EOF'`. */
  text: string
  /** Heredoc bodies declared on this segment's line, keyed by delimiter. */
  bodies: Map<string, string>
  /** True when this segment's stdout is piped onward rather than redirected. */
  piped: boolean
}

/** Splits one line into simple commands, ignoring operators inside quotes. */
function splitOperators(line: string): { text: string; piped: boolean }[] {
  const parts: { text: string; piped: boolean }[] = []
  let buf = ""
  let quote: string | null = null

  function flush(piped: boolean): void {
    if (buf.trim()) parts.push({ text: buf.trim(), piped })
    buf = ""
  }

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      buf += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buf += ch
      continue
    }
    if (ch === "|") {
      // `cat <<'EOF' | cmd` sends the body to a program, not to a file.
      flush(true)
      if (line[i + 1] === "|") i++
      continue
    }
    if (ch === ";" || (ch === "&" && line[i + 1] === "&")) {
      flush(false)
      if (ch === "&") i++
      continue
    }
    buf += ch
  }
  flush(false)
  return parts
}

/**
 * Flattens a command into simple segments, lifting heredoc bodies out of the
 * line flow so shell operators inside a body are never mistaken for structure.
 */
function segments(command: string): Segment[] {
  const lines = command.split("\n")
  const out: Segment[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    i++

    const bodies = new Map<string, string>()
    for (const decl of line.matchAll(HEREDOC_DECL_ALL)) {
      const [, dash, single, double] = decl
      const delim = single ?? double
      const body: string[] = []
      while (i < lines.length && lines[i].trim() !== delim) {
        body.push(dash ? lines[i].replace(/^\t+/, "") : lines[i])
        i++
      }
      if (i >= lines.length) continue // unterminated — the body is unknown
      i++ // consume the delimiter line
      bodies.set(delim, body.join("\n"))
    }

    for (const part of splitOperators(line)) {
      out.push({ text: part.text, bodies, piped: part.piped })
    }
  }
  return out
}

// ── Recognizers ──────────────────────────────────────────────────────────────

/** The directory a `cd` segment moves to, or null if it is not a plain `cd`. */
function cdTarget(segment: string, cwd: string | null): string | null {
  const m = segment.match(/^cd\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))\s*$/)
  if (!m) return null
  return resolvePath(m[1] ?? m[2] ?? m[3] ?? "", cwd)
}

/**
 * The file a `cat` redirect or `tee` truncates, still quoted, or null.
 * Appends are refused: without the prior content there is no honest diff.
 */
function writeTarget(text: string): string | null {
  const tee = text.match(/^tee\s+(?:(-a)\s+)?(?:"([^"]+)"|'([^']+)'|([^\s<>|;&]+))/)
  if (tee) {
    if (tee[1]) return null // tee -a
    return tee[2] ?? tee[3] ?? tee[4] ?? null
  }

  if (!/^cat\b/.test(text)) return null
  const redirect = text.match(/(>>?)\s*(?:"([^"]+)"|'([^']+)'|([^\s<>|;&]+))/)
  if (!redirect || redirect[1] === ">>") return null
  return redirect[2] ?? redirect[3] ?? redirect[4] ?? null
}

/** `cat > path <<'EOF'` / `tee path <<'EOF'` → Write. */
function heredocWrite(seg: Segment, cwd: string | null): Recovered | null {
  if (seg.piped || seg.bodies.size === 0) return null

  const decl = seg.text.match(HEREDOC_DECL)
  if (!decl) return null
  const body = seg.bodies.get(decl[2] ?? decl[3] ?? "")
  if (body === undefined) return null

  const target = writeTarget(seg.text)
  if (!target) return null
  const path = resolvePath(target, cwd)
  if (!path) return null

  return { name: "Write", input: { file_path: path, content: body } }
}

/**
 * The plain text a `sed` pattern matches, or null when it is a real regex.
 *
 * `\.` is an escaped dot and stays literal; a bare `.` is a wildcard and makes
 * the pattern unusable as an Edit's `old_string`. Escapes with their own
 * meaning (`\n`, `\1`, `\w`) disqualify it too.
 */
function literalText(source: string, side: "pattern" | "replacement"): string | null {
  const isReplacement = side === "replacement"
  let out = ""
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === "\\") {
      const next = source[i + 1]
      if (next === undefined) return null
      // `\|` is alternation in GNU BRE, not an escaped pipe.
      if (next === "|") return null
      // Only an escaped metacharacter, delimiter, or ampersand is plain text.
      if (!REGEX_METACHAR.test(next) && !"\\/&#".includes(next)) return null
      out += next
      i++
      continue
    }
    if (ch === "&" && isReplacement) return null // unescaped & re-inserts the match
    if (!isReplacement && REGEX_METACHAR.test(ch)) return null
    out += ch
  }
  return out
}

/** `sed -i '' 's/old/new/g' path`, with any delimiter and optional `-i` suffix. */
const SED_SUBSTITUTION =
  /^sed\s+-i(?:\.\S+)?\s+(?:''\s+|""\s+)?(?<quote>['"])s(?<sep>.)(?<pattern>(?:(?!\k<sep>).)*)\k<sep>(?<replacement>(?:(?!\k<sep>).)*)\k<sep>(?<flags>[a-zA-Z]*)\k<quote>\s+(?:"(?<dquoted>[^"]+)"|'(?<squoted>[^']+)'|(?<bare>[^\s<>|;&]+))$/

/** A `sed -i` substitution → Edit, when both sides are literal text. */
function sedEdit(seg: Segment, cwd: string | null): Recovered | null {
  const groups = seg.text.match(SED_SUBSTITUTION)?.groups
  if (!groups) return null

  const { pattern, replacement, flags, dquoted, squoted, bare } = groups
  // `i`/`I` match case-insensitively, so the pattern need not appear verbatim.
  if (/[^g]/.test(flags)) return null

  const oldString = literalText(pattern, "pattern")
  const newString = literalText(replacement, "replacement")
  // An empty pattern matches everywhere, so there is no diff worth showing.
  if (!oldString || newString === null) return null

  const path = resolvePath(dquoted ?? squoted ?? bare ?? "", cwd)
  if (!path) return null

  return {
    name: "Edit",
    input: {
      file_path: path,
      old_string: oldString,
      new_string: newString,
      replace_all: flags.includes("g"),
    },
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Recovers file writes from a Bash command, or [] when none are provable.
 * `cwd` anchors relative paths — pass the session's working directory.
 */
export function bashEdits(tc: ToolCall, cwd: string | null = null): ToolCall[] {
  const command = tc.input.command
  if (typeof command !== "string" || !command) return []

  const out: ToolCall[] = []
  let current = cwd

  for (const seg of segments(command)) {
    const moved = cdTarget(seg.text, current)
    if (moved) {
      current = moved
      continue
    }

    const recovered = heredocWrite(seg, current) ?? sedEdit(seg, current)
    if (recovered) {
      out.push(synthetic(tc, `${tc.id}:bash-${out.length}`, recovered.name, recovered.input))
    }
  }
  return out
}

/** Splits a MultiEdit into the individual Edits it stands for. */
function multiEdits(tc: ToolCall, cwd: string | null): ToolCall[] {
  const edits = tc.input.edits
  const rawPath = tc.input.file_path ?? tc.input.path
  if (!Array.isArray(edits) || typeof rawPath !== "string") return []
  const filePath = resolvePath(rawPath, cwd) ?? rawPath

  const out: ToolCall[] = []
  for (const [i, edit] of edits.entries()) {
    if (typeof edit !== "object" || edit === null) continue
    const { old_string: oldString, new_string: newString, replace_all: replaceAll } =
      edit as Record<string, unknown>
    if (typeof oldString !== "string" || typeof newString !== "string") continue

    out.push(synthetic(tc, `${tc.id}:edit-${i}`, "Edit", {
      file_path: filePath,
      old_string: oldString,
      new_string: newString,
      replace_all: replaceAll === true,
    }))
  }
  return out
}

/**
 * Every file change in `toolCalls`, expressed as Edit/Write calls.
 * Errored calls are dropped — they never touched the file.
 */
export function expandEditToolCalls(
  toolCalls: readonly ToolCall[],
  cwd: string | null = null,
): ToolCall[] {
  const out: ToolCall[] = []
  for (const tc of toolCalls) {
    if (tc.isError) continue
    if (tc.name === "Edit" || tc.name === "Write") out.push(tc)
    else if (tc.name === "MultiEdit") out.push(...multiEdits(tc, cwd))
    else if (tc.name === "Bash") out.push(...bashEdits(tc, cwd))
  }
  return out
}

/**
 * Whether anything in `toolCalls` changes a file. Stops at the first hit —
 * this runs in render bodies, on sessions that grow with every stream append.
 */
export function hasEditToolCalls(
  toolCalls: readonly ToolCall[],
  cwd: string | null = null,
): boolean {
  for (const tc of toolCalls) {
    if (tc.isError) continue
    if (tc.name === "Edit" || tc.name === "Write") return true
    if (tc.name === "MultiEdit" && multiEdits(tc, cwd).length > 0) return true
    if (tc.name === "Bash" && bashEdits(tc, cwd).length > 0) return true
  }
  return false
}
