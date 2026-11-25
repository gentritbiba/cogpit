import { RequestError, type InitializeResponse, type ToolCallContent } from "@agentclientprotocol/sdk"
import { agentSignedOutTitle } from "../../shared/session/agentFailures"
import { isRecord } from "../../shared/objects"
import { cogpitAgentEnv } from "../browser/agentEnv"
import { NO_COGPIT_SESSION } from "../browser/paths"
import { findExecutableOnPath } from "../lib/binaryResolver"
import { createAcpRuntime, type AcpProfile, type AcpToolCallState, type AcpToolUse, type AcpTurnSetting } from "./acpRuntime"
import { antigravityStore } from "./acpStore"
import { AgentRuntimeError, type SendRequest } from "./runtimeTypes"
import { agentNotInstalledError } from "./spawnError"

/** The first CLI release whose `agy acp` speaks the protocol this runtime expects. */
const MINIMUM_VERSION = [1, 5] as const

/** Cogpit's access picker in the agent's own mode names; full access answers each request itself. */
const MODES: Record<string, { value: string; required: boolean }> = {
  default: { value: "default", required: false },
  acceptEdits: { value: "accept-edits", required: true },
  plan: { value: "plan", required: true },
  auto: { value: "auto", required: true },
  bypassPermissions: { value: "default", required: false },
}

export function antigravityTurnSettings(request: SendRequest): AcpTurnSetting[] {
  if (request.fastMode || request.ultracode || request.mcpConfig || request.contextWindowTokens || request.permissions?.allowedTools?.length || request.permissions?.disallowedTools?.length) {
    throw new AgentRuntimeError(400, "ACP_ERROR", "These settings are not supported by Antigravity")
  }
  const mode = request.permissions?.mode ? MODES[request.permissions.mode] : undefined
  if (request.permissions?.mode && !mode) throw new AgentRuntimeError(400, "ACP_ERROR", `Antigravity has no "${request.permissions.mode}" mode`)
  return [
    ...request.model ? [{ category: "model", value: request.model, required: true }] : [],
    ...request.effort ? [{ category: "thought_level", value: request.effort, required: false }] : [],
    ...mode ? [{ category: "mode", ...mode }] : [],
  ]
}

function checkVersion(response: InitializeResponse): void {
  const version = /(\d+)\.(\d+)\.\d+/.exec(response.agentInfo?.version ?? "")
  const [major, minor] = version ? [Number(version[1]), Number(version[2])] : [0, 0]
  if (major > MINIMUM_VERSION[0] || (major === MINIMUM_VERSION[0] && minor >= MINIMUM_VERSION[1])) return
  throw new AgentRuntimeError(400, "ACP_ERROR", `Antigravity CLI ${MINIMUM_VERSION.join(".")} or newer is required (found ${response.agentInfo?.version ?? "an unknown version"}). Run: agy update`)
}

/** The agent's sign-in errors: `-32000`, or an internal error saying it could not open a browser. */
function isSignInError(cause: unknown): boolean {
  return cause instanceof RequestError && (cause.code === -32000 || (cause.code === -32603 && cause.message.startsWith("No browser is available here")))
}

const text = (value: unknown) => typeof value === "string" && value ? value : undefined
const firstText = (input: Record<string, unknown>, ...keys: string[]) => keys.map((key) => text(input[key])).find(Boolean)

/** The tool's own name, from titles like `Running run_command` or `Run edit_file?`. */
function toolName(title: string | null | undefined): string | undefined {
  return title?.replace(/^(?:Running|Run)\s+/, "").replace(/\?$/, "").trim() || undefined
}

function diffOf(content: ToolCallContent[] | null | undefined) {
  const diff = content?.find((block) => block.type === "diff")
  return diff?.type === "diff" ? diff : undefined
}

/**
 * The Claude tool a call corresponds to, so the timeline draws it with the
 * same command, edit and search cards. Anything else keeps the agent's name.
 */
export function antigravityToolUse(tool: AcpToolCallState): AcpToolUse {
  const input = isRecord(tool.rawInput) ? tool.rawInput : {}
  const name = toolName(tool.title)
  const command = firstText(input, "CommandLine", "command_line", "commandLine", "command")
  if (command || tool.kind === "execute") {
    const cwd = firstText(input, "Cwd", "WorkingDirectory", "working_dir", "workingDir", "cwd")
    return { name: "Bash", input: { command: command ?? name ?? "", ...cwd ? { cwd } : {} } }
  }
  const diff = diffOf(tool.content)
  if (diff) return diff.oldText ? { name: "Edit", input: { file_path: diff.path, old_string: diff.oldText, new_string: diff.newText } } : { name: "Write", input: { file_path: diff.path, content: diff.newText } }
  const path = firstText(input, "AbsolutePath", "absolute_path", "TargetFile", "file_path", "path") ?? tool.locations?.[0]?.path
  if (tool.kind === "edit" && path) return { name: "Edit", input: { file_path: path } }
  if (tool.kind === "read" && path) return { name: "Read", input: { file_path: path } }
  if (name === "search_web" || name === "web_search") return { name: "WebSearch", input: { query: firstText(input, "query", "Query") ?? "" } }
  if (name === "update_steps" && Array.isArray(input.steps)) {
    const todos = input.steps.filter(isRecord).map((step) => ({ content: text(step.title) ?? "", status: step.status === "done" ? "completed" : step.status === "in_progress" ? "in_progress" : "pending" }))
    return { name: "TodoWrite", input: { todos } }
  }
  if (tool.kind === "search") return { name: "Grep", input: { pattern: firstText(input, "Query", "query", "Pattern", "pattern") ?? "", ...path ? { path } : {} } }
  return { name: name ?? tool.kind ?? "Tool", input }
}

/** A command's output is in `combinedOutput`; everything else reads as text content. */
export function antigravityToolResult(tool: AcpToolCallState): string | undefined {
  return isRecord(tool.rawOutput) ? firstText(tool.rawOutput, "combinedOutput", "combined_output") : undefined
}

export const antigravityProfile: AcpProfile = {
  kind: "antigravity", store: antigravityStore, label: "Antigravity", headerType: "antigravity_session", nativeSessionIds: true,
  launch() {
    const command = process.env.COGPIT_PROVIDER_EXECUTABLE || findExecutableOnPath("agy")
    if (!command) throw agentNotInstalledError("antigravity")
    return { command, args: ["acp"], env: cogpitAgentEnv(process.env, NO_COGPIT_SESSION) }
  },
  checkInitialize: checkVersion,
  turnSettings: antigravityTurnSettings,
  routePermission(request, mode) {
    // The agent asks the person a multiple-choice question through a permission request.
    if (request.toolCall.toolCallId.startsWith("interaction_")) return "question"
    if (mode === "bypassPermissions") return { optionKind: "allow_once" }
    if (mode === "acceptEdits" && request.toolCall.kind === "edit") return { optionKind: "allow_once" }
    return "ask"
  },
  toolUse: antigravityToolUse,
  deferToolCalls: true,
  toolResult: antigravityToolResult,
  explainError: (cause) => isSignInError(cause) ? new AgentRuntimeError(401, "NOT_SIGNED_IN", `${agentSignedOutTitle("antigravity")} Run: agy acp --login`) : null,
}

export const antigravityRuntime = createAcpRuntime(antigravityProfile)
