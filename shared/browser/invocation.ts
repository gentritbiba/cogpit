// Browser-safe: where an `agent-browser` call sits inside a shell command, and
// which managed browser it drives. Declared once here because two callers need
// the same answer and would otherwise each guess it — the transcript scan that
// captions the panel (`shared/session/browserActivity.ts`) and the hook that
// moves a subagent onto a throwaway browser (`server/browser/agentContext.ts`).
// No node imports.

import { DEFAULT_BROWSER } from "./names"

export const BROWSER_BINARY = "agent-browser"

/**
 * The binary as a word, optionally reached through a path, so
 * `/usr/local/bin/agent-browser open x` counts while `cat agent-browser-plan.md`
 * does not.
 */
const INVOCATION = /(?:^|[\s;&|(`"'])(?:[^\s;&|`"']*\/)?agent-browser(?![\w.-])/
const SEPARATOR = /&&|;|\n/
const SESSION_FLAG = /--session(?:=|\s+)(['"]?)([^\s'"]+)\1/

export interface BrowserInvocation {
  /** The invocation, from the binary up to the next command separator. */
  text: string
  /** Index just past the binary token, where a flag can be inserted. */
  binaryEnd: number
  /** Index just past the invocation: the next command separator, or the end. */
  end: number
  /** The managed browser it drives: the `--session` value, else the default one. */
  browser: string
  /** Where `--session <name>` sits in the whole command, when it is given at all. */
  sessionFlag: { start: number; end: number } | null
}

/** Every `agent-browser` call in a shell command, in the order they run. */
export function findBrowserInvocations(command: string): BrowserInvocation[] {
  const found: BrowserInvocation[] = []
  const scan = new RegExp(INVOCATION, "g")
  for (let match = scan.exec(command); match !== null; match = scan.exec(command)) {
    const binaryEnd = match.index + match[0].length
    const separator = SEPARATOR.exec(command.slice(binaryEnd))
    const end = separator === null ? command.length : binaryEnd + separator.index
    const flag = SESSION_FLAG.exec(command.slice(binaryEnd, end))
    found.push({
      text: command.slice(binaryEnd - BROWSER_BINARY.length, end).trim(),
      binaryEnd,
      end,
      browser: flag?.[2] ?? DEFAULT_BROWSER,
      sessionFlag: flag === null
        ? null
        : { start: binaryEnd + flag.index, end: binaryEnd + flag.index + flag[0].length },
    })
  }
  return found
}
