import { asRecord } from "../../shared/objects"
import { projectElicitationSchema } from "../lib/elicitationSchema"
import type {
  ApprovalDecision,
  ElicitationResponse,
  JsonObject,
  McpToolCallRequest,
  PendingElicitation,
} from "./codexAppServerProtocol"
import { mcpToolCallDecisions } from "./codexApprovalCodec"

/**
 * `mcpServer/elicitation/request` carries two different things. Codex asks for
 * approval of an MCP tool call as a form elicitation with an empty schema and
 * `_meta.codex_approval_kind: "mcp_tool_call"`; anything without an approval
 * kind is an MCP server asking the user for input, by form or by link.
 */
export type RoutedElicitation =
  | {
      route: "approval"
      toolCall: Omit<McpToolCallRequest, "serverName">
      availableDecisions: ApprovalDecision[]
    }
  | {
      route: "prompt"
      prompt: Pick<PendingElicitation, "mode" | "message" | "url" | "fields">
    }
  /** `reason` finishes the sentence "Declined a request from MCP server X: …". */
  | { route: "decline"; reason: string }

function text(object: JsonObject, key: string): string | undefined {
  const value = object[key]
  return typeof value === "string" && value ? value : undefined
}

/** Prefer Codex's display list, which carries its own labels and order. */
function toolParams(meta: JsonObject): JsonObject | undefined {
  const shown: JsonObject = {}
  for (const entry of Array.isArray(meta.tool_params_display) ? meta.tool_params_display : []) {
    const param = asRecord(entry)
    const name = param && (text(param, "display_name") ?? text(param, "name"))
    if (param && name) shown[name] = param.value
  }
  const params = Object.keys(shown).length > 0 ? shown : asRecord(meta.tool_params)
  return params && Object.keys(params).length > 0 ? params : undefined
}

function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === "https:" || protocol === "http:"
  } catch {
    return false
  }
}

export function routeElicitation(params: JsonObject): RoutedElicitation {
  const mode = params.mode
  if (mode === "openai/userVerification") {
    return { route: "decline", reason: "Cogpit cannot verify the user on this device" }
  }
  if (mode !== "form" && mode !== "url") {
    return { route: "decline", reason: `Cogpit has no prompt for "${String(mode)}" requests` }
  }

  const message = text(params, "message") ?? ""
  const meta = asRecord(params._meta) ?? {}
  const projection = mode === "form"
    ? projectElicitationSchema(asRecord(params.requestedSchema) ?? undefined)
    : { fields: [] }

  const approvalKind = meta.codex_approval_kind
  if (approvalKind !== undefined) {
    if (approvalKind !== "mcp_tool_call") {
      return {
        route: "decline",
        reason: `Cogpit has no prompt for "${String(approvalKind)}" approvals`,
      }
    }
    // The permission bar can only show a tool call in full when there is
    // nothing to fill in.
    if (mode !== "form" || !("fields" in projection) || projection.fields.length > 0) {
      return {
        route: "decline",
        reason: "Cogpit cannot show a tool-call approval that also asks for input",
      }
    }
    const connectorName = text(meta, "connector_name")
    const toolTitle = text(meta, "tool_title")
    const toolDescription = text(meta, "tool_description")
    const shown = toolParams(meta)
    return {
      route: "approval",
      toolCall: {
        message,
        ...(connectorName && { connectorName }),
        ...(toolTitle && { toolTitle }),
        ...(toolDescription && { toolDescription }),
        ...(shown && { toolParams: shown }),
      },
      availableDecisions: mcpToolCallDecisions(meta.persist),
    }
  }

  if ("unsupported" in projection) {
    return {
      route: "decline",
      reason: "Cogpit renders text, number, checkbox and choice fields only, and "
        + projection.unsupported,
    }
  }
  if (mode === "form") {
    return { route: "prompt", prompt: { mode, message, fields: projection.fields } }
  }
  const url = text(params, "url")
  if (!url || !isWebUrl(url)) {
    return { route: "decline", reason: "its link is not a web address" }
  }
  return { route: "prompt", prompt: { mode, message, url, fields: [] } }
}

/** Decline and cancel carry no content; an accepted link has none to carry. */
export function wireElicitationResponse(response: ElicitationResponse): JsonObject {
  return response.action === "accept"
    ? { action: "accept", content: response.content ?? null }
    : { action: response.action }
}
