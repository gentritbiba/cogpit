import type {
  ApprovalDecision,
  PendingApproval,
} from "./codex-app-server-protocol"

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
