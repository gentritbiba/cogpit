// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
import type { ToolCall } from "./types"

interface JsStringLiteral {
  endIndex: number
  value: string
}

const JS_SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  "0": "\0",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
}

function readJsStringLiteral(source: string, startIndex: number): JsStringLiteral | null {
  const quote = source[startIndex]
  if (quote !== '"' && quote !== "'" && quote !== "`") return null

  let value = ""
  let index = startIndex + 1
  while (index < source.length) {
    const char = source[index]
    if (char === quote) return { endIndex: index + 1, value }
    if (char !== "\\") {
      value += char
      index++
      continue
    }

    index++
    if (index >= source.length) return null
    const escaped = source[index]
    if (escaped in JS_SIMPLE_ESCAPES) {
      value += JS_SIMPLE_ESCAPES[escaped]
      index++
      continue
    }
    if (escaped === "\n") {
      index++
      continue
    }
    if (escaped === "\r") {
      index += source[index + 1] === "\n" ? 2 : 1
      continue
    }
    if (escaped === "x" && /^[0-9a-fA-F]{2}$/.test(source.slice(index + 1, index + 3))) {
      value += String.fromCharCode(Number.parseInt(source.slice(index + 1, index + 3), 16))
      index += 3
      continue
    }
    if (escaped === "u") {
      const braced = source.slice(index + 1).match(/^\{([0-9a-fA-F]+)\}/)
      if (braced) {
        const codePoint = Number.parseInt(braced[1], 16)
        if (Number.isFinite(codePoint) && codePoint <= 0x10ffff) {
          value += String.fromCodePoint(codePoint)
          index += braced[0].length + 1
          continue
        }
      }
      const hex = source.slice(index + 1, index + 5)
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        value += String.fromCharCode(Number.parseInt(hex, 16))
        index += 5
        continue
      }
    }

    value += escaped
    index++
  }

  return null
}

function isApplyPatchText(value: string): boolean {
  return value.includes("*** Begin Patch") && value.includes("*** End Patch")
}

/** Extract patch payloads passed to nested `tools.apply_patch(...)` calls in Codex exec scripts. */
export function extractApplyPatchInputs(execSource: string): string[] {
  if (!execSource.includes("apply_patch") || !execSource.includes("*** Begin Patch")) return []

  const assignedPatches = new Map<string, string>()
  for (let index = 0; index < execSource.length; index++) {
    const literal = readJsStringLiteral(execSource, index)
    if (!literal) continue
    if (isApplyPatchText(literal.value)) {
      const assignment = execSource
        .slice(0, index)
        .match(/(?:^|[;\n])\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/)
      if (assignment) assignedPatches.set(assignment[1], literal.value)
    }
    index = literal.endIndex - 1
  }

  const patches: string[] = []
  const seen = new Set<string>()
  const applyCall = /\btools\s*\.\s*apply_patch\s*\(/g
  let match: RegExpExecArray | null
  while ((match = applyCall.exec(execSource)) !== null) {
    let argumentIndex = match.index + match[0].length
    while (/\s/.test(execSource[argumentIndex] ?? "")) argumentIndex++

    const literal = readJsStringLiteral(execSource, argumentIndex)
    const identifier = literal
      ? null
      : execSource.slice(argumentIndex).match(/^([A-Za-z_$][\w$]*)/)
    const patch = literal?.value ?? (identifier ? assignedPatches.get(identifier[1]) : undefined)
    if (!patch || !isApplyPatchText(patch) || seen.has(patch)) continue
    seen.add(patch)
    patches.push(patch)
  }

  return patches
}

function resolveCodexPatchPath(filePath: string, cwd: string): string {
  if (!cwd || filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath)) return filePath
  return `${cwd.replace(/[\\/]+$/, "")}/${filePath.replace(/^\.\//, "")}`
}

/** Parse a Codex apply_patch string into per-file Edit/Write tool calls. */
export function parseApplyPatch(
  patchText: string,
  callId: string,
  timestamp: string,
  cwd = "",
): ToolCall[] {
  const toolCalls: ToolCall[] = []
  // Split into per-file sections
  const filePattern = /^\*\*\*\s+(Update File|Add File|Delete File):\s*(.+)$/gm
  const sections: Array<{ action: string; filePath: string; headerIdx: number; startIdx: number }> = []
  let match: RegExpExecArray | null
  while ((match = filePattern.exec(patchText)) !== null) {
    sections.push({
      action: match[1],
      filePath: match[2].trim(),
      headerIdx: match.index,
      startIdx: match.index + match[0].length,
    })
  }

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]
    const endIdx = i + 1 < sections.length ? sections[i + 1].headerIdx : patchText.length
    const body = patchText.slice(section.startIdx, endIdx)
    const movedTo = body.match(/^\*\*\*\s+Move to:\s*(.+)$/m)?.[1]?.trim()
    const sourcePath = resolveCodexPatchPath(section.filePath, cwd)
    const filePath = resolveCodexPatchPath(movedTo || section.filePath, cwd)

    // Parse hunks between @@ markers
    const hunkBodies = body.split(/^@@.*$/m).filter((s) => s.trim())
    const oldLines: string[] = []
    const newLines: string[] = []

    for (const hunk of hunkBodies) {
      for (const line of hunk.split("\n")) {
        if (line.startsWith("-")) {
          oldLines.push(line.slice(1))
        } else if (line.startsWith("+")) {
          newLines.push(line.slice(1))
        } else if (line.startsWith(" ")) {
          oldLines.push(line.slice(1))
          newLines.push(line.slice(1))
        }
      }
    }

    const fileId = sections.length > 1 ? `${callId}:file-${i}` : callId

    if (section.action === "Add File") {
      toolCalls.push({
        id: fileId,
        name: "Write",
        input: { file_path: filePath, content: newLines.join("\n") },
        result: null,
        isError: false,
        timestamp,
      })
    } else if (section.action === "Delete File") {
      toolCalls.push({
        id: fileId,
        name: "Edit",
        input: { file_path: filePath, old_string: oldLines.join("\n"), new_string: "" },
        result: null,
        isError: false,
        timestamp,
      })
    } else {
      // Update File → Edit
      toolCalls.push({
        id: fileId,
        name: "Edit",
        input: {
          file_path: filePath,
          ...(movedTo ? { old_path: sourcePath } : {}),
          old_string: oldLines.join("\n"),
          new_string: newLines.join("\n"),
        },
        result: null,
        isError: false,
        timestamp,
      })
    }
  }

  return toolCalls
}

/** Normalize direct and exec-wrapped Codex apply_patch calls into file tool calls. */
export function parseCodexToolPatches(
  toolName: string,
  rawInput: string,
  callId: string,
  timestamp: string,
  cwd = "",
): ToolCall[] {
  if (toolName === "apply_patch") {
    return parseApplyPatch(rawInput, callId, timestamp, cwd)
  }

  return extractApplyPatchInputs(rawInput).flatMap((patch, patchIndex) =>
    parseApplyPatch(patch, `${callId}:patch-${patchIndex}`, timestamp, cwd)
  )
}

/** Attribute an exec-wrapper patch failure without tainting earlier successful patch calls. */
export function findFailedNestedPatchCallIds(
  output: string,
  wrapperIsError: boolean,
  calls: readonly ToolCall[],
): Set<string> {
  if (!wrapperIsError
    || !/(?:apply[_ ]patch|invalid patch|invalid context|failed to (?:apply|find)|could not apply)/i.test(output)) {
    return new Set()
  }

  const groups = new Map<number, ToolCall[]>()
  for (const call of calls) {
    const patchIndex = call.id.match(/:patch-(\d+)(?::file-\d+)?$/)?.[1]
    if (patchIndex === undefined) continue
    const index = Number(patchIndex)
    const group = groups.get(index) ?? []
    group.push(call)
    groups.set(index, group)
  }
  if (groups.size === 0) return new Set(calls.map((call) => call.id))

  const normalizedOutput = output.toLowerCase().replaceAll("\\", "/")
  const mentionedGroups = new Set<number>()
  for (const [index, group] of groups) {
    if (group.some((call) => {
      const filePath = String(call.input.file_path ?? "").toLowerCase().replaceAll("\\", "/")
      if (!filePath) return false
      const segments = filePath.split("/").filter(Boolean)
      const suffix = segments.slice(-2).join("/")
      return normalizedOutput.includes(filePath)
        || (suffix.includes("/") && normalizedOutput.includes(suffix))
    })) {
      mentionedGroups.add(index)
    }
  }

  for (const match of normalizedOutput.matchAll(/\bpatch\s*(?:#|-)?\s*(\d+)\b/g)) {
    const index = Number(match[1])
    if (groups.has(index)) mentionedGroups.add(index)
  }

  // Exec scripts run nested calls sequentially. If the aggregate error does
  // not identify a patch, attribute it to the final call that could have failed.
  if (mentionedGroups.size === 0) mentionedGroups.add(Math.max(...groups.keys()))

  const firstFailedIndex = Math.min(...mentionedGroups)
  for (const index of groups.keys()) {
    if (index >= firstFailedIndex) mentionedGroups.add(index)
  }

  return new Set(
    [...mentionedGroups].flatMap((index) => groups.get(index)?.map((call) => call.id) ?? []),
  )
}
