/**
 * Wire contract for GET /api/agent-prompts — the out-of-band prompts a live
 * Claude session is blocked on that are NOT tool calls: MCP elicitations
 * (`onElicitation`) and CLI user dialogs (`onUserDialog`). Browser-safe.
 *
 * Both are answered through a callback the CLI is parked on, so neither ever
 * reaches a transcript. The in-memory resolver map is the only source: being
 * listed here means the prompt can still be answered.
 */

/** Field kinds Cogpit renders. A schema needing anything else is declined outright. */
export type ElicitationFieldType = "string" | "number" | "integer" | "boolean" | "enum"

export interface ElicitationFieldOption {
  value: string
  label: string
}

export interface MissionControlElicitationField {
  name: string
  /** Schema `title`, falling back to the property name. */
  label: string
  type: ElicitationFieldType
  required: boolean
  description?: string
  /** Present for `enum` fields only, in schema order. */
  options?: ElicitationFieldOption[]
  defaultValue?: string | number | boolean
}

/** An MCP elicitation blocking a session. */
export interface MissionControlElicitation {
  sessionId: string
  /** The control_request id — the only thing that can answer it. */
  requestId: string
  serverName: string
  message: string
  /** `url` asks the user to open a link; `form` asks for `fields`. */
  mode: "form" | "url"
  url?: string
  title?: string
  displayName?: string
  description?: string
  askedAt: number
  /** Empty for `url` mode and for a bare confirm with no schema. */
  fields: MissionControlElicitationField[]
}

/** Values an accepted elicitation may carry back, per the MCP ElicitResult schema. */
export type ElicitationContent = Record<string, string | number | boolean | string[]>

export type ElicitationAction = "accept" | "decline" | "cancel"

/**
 * The refusal fallback dialog: the model refused on `originalModel` and the CLI
 * offers to retry on `fallbackModel` instead of ending the turn with the
 * classic refusal error.
 */
export interface MissionControlRefusalFallbackDialog {
  sessionId: string
  requestId: string
  dialogKind: "refusal_fallback_prompt"
  askedAt: number
  originalModel: string
  fallbackModel: string
  guidanceText?: string
}

/** Every dialog kind Cogpit declares in `supportedDialogKinds`. */
export type MissionControlUserDialog = MissionControlRefusalFallbackDialog

/** Choices `refusal_fallback_prompt` accepts; `cancelled` applies the CLI default. */
export type RefusalFallbackChoice = "retry_fallback" | "edit_prompt" | "cancelled"

export type UserDialogChoice = RefusalFallbackChoice

/** Response body of GET /api/agent-prompts. */
export interface AgentPromptsResponse {
  elicitationsBySession: Record<string, MissionControlElicitation[]>
  dialogsBySession: Record<string, MissionControlUserDialog[]>
}
