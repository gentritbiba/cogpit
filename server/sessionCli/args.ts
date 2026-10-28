/** Argument parsing and output shared by the `cogpit-session` commands. */

import type { IncomingMessage } from "node:http"
import type { VisibilityCheck } from "../edition"

export interface CliInvocation {
  argv: string[]
  /** The caller's working directory, the default project for `new`. */
  cwd: string
  /** The calling agent's own session, from `COGPIT_SESSION_ID`. */
  callerSessionId?: string
  /** Stable across the script's retries of one invocation. */
  invocationId: string
  /** Who the create-once guarantee is scoped to. */
  scope: string
  /**
   * Whether the caller may move repositories between machines. Workspace
   * transfers run with the hub's own device credentials, so a team member who
   * could not call the workspace routes must not reach them through here.
   */
  admin: boolean
  /** Which sessions the caller may see, and so which projects it may list. */
  visible: VisibilityCheck
  signal?: AbortSignal
  req?: IncomingMessage
}

export interface CliOutput {
  exitCode: number
  stdout: string
  stderr: string
}

export const EXIT = { ok: 0, error: 1, needsInput: 2, timedOut: 3 } as const

export class UsageError extends Error {}

export interface ParsedArgs {
  positionals: string[]
  values: Map<string, string>
  switches: Set<string>
}

export function parseArgs(args: string[], valueFlags: readonly string[], switchFlags: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], values: new Map(), switches: new Set() }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith("--") || arg === "--") {
      parsed.positionals.push(arg)
      continue
    }
    const eq = arg.indexOf("=")
    const name = arg.slice(2, eq === -1 ? undefined : eq)
    if (switchFlags.includes(name) && eq === -1) {
      parsed.switches.add(name)
    } else if (valueFlags.includes(name)) {
      const value = eq === -1 ? args[++i] : arg.slice(eq + 1)
      if (value === undefined) throw new UsageError(`--${name} needs a value`)
      parsed.values.set(name, value)
    } else {
      throw new UsageError(`Unknown option --${name}`)
    }
  }
  return parsed
}

export function json(value: unknown, exitCode: number = EXIT.ok): CliOutput {
  return { exitCode, stdout: `${JSON.stringify(value, null, 2)}\n`, stderr: "" }
}
