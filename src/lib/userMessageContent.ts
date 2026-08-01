// A user turn is rarely just what the human typed. Claude Code injects context
// blocks, echoes slash commands and their stdout, and posts background-task
// events as fake user messages. Everything that pulls those apart lives here so
// the timeline and the sticky banner can never drift out of sync again — they
// used to carry two hand-maintained copies of the tag list.
//
// The iOS client mirrors this in `ios/CogpitKit/Sources/CogpitKit/Transcript/UserMessageContent.swift`.

import { stripAnsi } from "@/lib/ansi"

/** Paired blocks that are pure injected context: hidden, with a "show raw" escape hatch. */
export const SYSTEM_TAG_NAMES = [
  "system-reminder",
  "local-command-caveat",
  "command-name",
  "command-message",
  "command-args",
  "env",
  "claude_background_info",
  "fast_mode_info",
  "gitStatus",
  "user-prompt-submit-hook",
] as const

const SYSTEM_TAG_ALTERNATION = SYSTEM_TAG_NAMES.join("|")

/**
 * Rebuilt per call: a shared /g regex carries `lastIndex` between callers.
 * The backreference matters — an alternation on both ends lets a nested block
 * (`<system-reminder>…<env>x</env>…</system-reminder>`) close on the inner tag,
 * leaking the outer block's tail and a bare `</system-reminder>` as prose.
 */
function systemTagRe(): RegExp {
  return new RegExp(`<(${SYSTEM_TAG_ALTERNATION})[^>]*>[\\s\\S]*?<\\/\\1>`, "g")
}

export function stripSystemTags(text: string): string {
  return text.replace(systemTagRe(), "").trim()
}

/** True when `text` carries any injected block, i.e. "Show raw" is worth offering. */
export function hasSystemTags(text: string): boolean {
  return systemTagRe().test(text)
}

// ── Slash commands ──────────────────────────────────────────────────────

const COMMAND_MESSAGE_RE = /<command-message>([^<]+)<\/command-message>/
const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/

export function extractCommandName(text: string): string | null {
  const message = text.match(COMMAND_MESSAGE_RE)
  if (message) return message[1]
  // Fall back to <command-name>, which arrives already slashed.
  const name = text.match(COMMAND_NAME_RE)
  return name ? name[1].trim().replace(/^\//, "") : null
}

export function extractCommandArgs(text: string): string | null {
  const match = text.match(COMMAND_ARGS_RE)
  if (!match) return null
  const args = match[1].trim()
  return args.length > 0 ? args : null
}

// ── Local command / bash-mode output ────────────────────────────────────

export type CommandOutputStream = "stdout" | "stderr" | "input"

export interface LocalCommandOutput {
  text: string
  stream: CommandOutputStream
}

/** Tag name → the stream its body belongs to. `bash-*` is `!bash` mode, which echoes the typed command too. */
const OUTPUT_TAG_STREAMS: Record<string, CommandOutputStream> = {
  "local-command-stdout": "stdout",
  "local-command-stderr": "stderr",
  "bash-input": "input",
  "bash-stdout": "stdout",
  "bash-stderr": "stderr",
}

const OUTPUT_TAG_RE = new RegExp(
  `<(${Object.keys(OUTPUT_TAG_STREAMS).join("|")})>([\\s\\S]*?)<\\/\\1>`,
  "g",
)

export function parseLocalCommandOutputs(text: string): {
  outputs: LocalCommandOutput[]
  remainingText: string
} {
  const outputs: LocalCommandOutput[] = []
  const remainingText = text
    .replace(OUTPUT_TAG_RE, (_, tag: string, inner: string) => {
      // Slash commands emit styled output; without this the user reads `[1m`.
      outputs.push({ text: stripAnsi(inner).trim(), stream: OUTPUT_TAG_STREAMS[tag] })
      return ""
    })
    .trim()
  return { outputs, remainingText }
}

// ── Task notifications ──────────────────────────────────────────────────

export interface TaskNotification {
  taskId: string
  toolUseId: string
  /** Where the task's full output was written. */
  outputFile: string
  status: string
  summary: string
  result: string
}

const TASK_NOTIFICATION_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))
  return match ? match[1].trim() : ""
}

export function parseTaskNotifications(text: string): {
  notifications: TaskNotification[]
  remainingText: string
} {
  const notifications: TaskNotification[] = []
  const remainingText = text
    .replace(TASK_NOTIFICATION_RE, (_, inner: string) => {
      notifications.push({
        taskId: extractTag(inner, "task-id"),
        toolUseId: extractTag(inner, "tool-use-id"),
        outputFile: extractTag(inner, "output-file"),
        status: extractTag(inner, "status"),
        summary: extractTag(inner, "summary"),
        result: extractTag(inner, "result"),
      })
      return ""
    })
    .trim()
  return { notifications, remainingText }
}

// ── Interrupts ──────────────────────────────────────────────────────────

const INTERRUPT_RE = /\[Request interrupted by user[^\]]*\]/g

export function parseInterrupts(text: string): { interrupts: string[]; remainingText: string } {
  const interrupts: string[] = []
  const remainingText = text
    .replace(INTERRUPT_RE, (match) => {
      interrupts.push(match)
      return ""
    })
    .trim()
  return { interrupts, remainingText }
}

// ── Background-task event banner ────────────────────────────────────────

export const SYSTEM_NOTIFICATION_MARKER = "[SYSTEM NOTIFICATION - NOT USER INPUT]"

/**
 * Background-task events arrive as user records fronted by a disclaimer aimed at
 * the model. It is noise to a human reading the transcript, so it is dropped and
 * the message is flagged instead.
 */
export function stripSystemNotificationPreamble(text: string): {
  text: string
  isSystemNotification: boolean
} {
  const start = text.indexOf(SYSTEM_NOTIFICATION_MARKER)
  if (start === -1) return { text, isSystemNotification: false }
  const afterMarker = start + SYSTEM_NOTIFICATION_MARKER.length
  const blankLine = text.indexOf("\n\n", afterMarker)
  // Bounded deliberately: with no blank line, dropping to end-of-string would
  // silently swallow the entire message.
  const end = blankLine === -1 ? afterMarker : blankLine + 2
  return {
    text: (text.slice(0, start) + text.slice(end)).trim(),
    isSystemNotification: true,
  }
}
