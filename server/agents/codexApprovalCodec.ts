import { readShellCommands } from "../../shared/browser/shellWords"
import type {
  ApprovalDecision,
  JsonObject,
  PendingApproval,
} from "./codexAppServerProtocol"

const DEFAULT_APPROVAL_DECISIONS: readonly ApprovalDecision[] = [
  "allow",
  "allow_always",
  "deny",
]

/**
 * Translate the protocol's richer decision union into the three decisions the
 * shared Cogpit approval UI can express. Amendment-bearing decisions remain
 * unavailable until Cogpit has a dedicated UI for reviewing their payloads.
 */
export function normalizeAvailableDecisions(value: unknown): ApprovalDecision[] {
  if (value == null) return [...DEFAULT_APPROVAL_DECISIONS]
  if (!Array.isArray(value)) return []

  const decisions: ApprovalDecision[] = []
  const add = (decision: ApprovalDecision) => {
    if (!decisions.includes(decision)) decisions.push(decision)
  }
  for (const decision of value) {
    if (decision === "accept") add("allow")
    else if (decision === "acceptForSession") add("allow_always")
    else if (decision === "decline" || decision === "cancel") add("deny")
  }
  return decisions
}

export function wireApprovalDecision(
  approval: PendingApproval,
  decision: ApprovalDecision,
): unknown {
  const available = approval.params.availableDecisions
  if (!Array.isArray(available)) {
    return {
      allow: "accept",
      allow_always: "acceptForSession",
      deny: "decline",
    }[decision]
  }

  if (decision === "allow") {
    return available.find((candidate) => candidate === "accept")
  }
  if (decision === "allow_always") {
    return available.find((candidate) => candidate === "acceptForSession")
  }
  return available.find(
    (candidate) => candidate === "decline" || candidate === "cancel",
  )
}

/**
 * `_meta.persist` names the grants a client may offer to remember: one value or
 * a list. Only `session` has a button that says so; the persistent `always`
 * grant is never offered, so no decision can widen into it.
 */
export function mcpToolCallDecisions(persist: unknown): ApprovalDecision[] {
  const offered: unknown[] = Array.isArray(persist) ? persist : [persist]
  return offered.includes("session")
    ? ["allow", "allow_always", "deny"]
    : ["allow", "deny"]
}

const MCP_TOOL_CALL_RESULTS: Readonly<Record<ApprovalDecision, JsonObject>> = {
  allow: { action: "accept", content: null },
  allow_always: { action: "accept", content: null, _meta: { persist: "session" } },
  deny: { action: "decline" },
}

/** The JSON-RPC result that answers `approval`, or undefined when the decision has no wire form. */
export function wireApprovalResult(
  approval: PendingApproval,
  decision: ApprovalDecision,
): JsonObject | undefined {
  if (approval.kind === "mcpToolCall") return MCP_TOOL_CALL_RESULTS[decision]
  const wireDecision = wireApprovalDecision(approval, decision)
  return wireDecision === undefined ? undefined : { decision: wireDecision }
}

/**
 * A `writeStdin` approval describes its target only as a synthetic shell-quoted
 * command, `write_stdin --session-id <process> <input>`. Null when the command
 * is not in that shape.
 */
export function readTerminalInput(
  command: string | undefined,
): { processId: string; input: string } | null {
  if (!command) return null
  const { commands, complete } = readShellCommands(command)
  const words = complete && commands.length === 1 ? commands[0].words : []
  if (
    words.length !== 4 ||
    words[0].value !== "write_stdin" ||
    words[1].value !== "--session-id"
  ) {
    return null
  }
  return { processId: words[2].value, input: words[3].value }
}
