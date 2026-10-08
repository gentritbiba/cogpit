// Generated from OpenAI Codex 0.160.0; run bun scripts/generate-codex-protocol.ts --refresh.
// Apache-2.0; see codex-LICENSE. Schema SHA-256: e6817894c045abffafbdaee87f2f14493fc9943cba18a17894823b472c21357b

export type AbsolutePathBuf = string
export type ActivePermissionProfile = { "extends"?: string | null; "id": string }
export type AdditionalContextEntry = { "kind": AdditionalContextKind; "value": string }
export type AdditionalContextKind = "untrusted" | "application"
export type AgentMessageDelivery = "async"
export type AgentMessageInputContent = ({ "text": string; "type": "input_text" }) | ({ "encrypted_content": string; "type": "encrypted_content" })
export type AgentPath = string
export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent"
export type AskForApproval = ("untrusted" | "on-request" | "never") | ({ "granular": { "mcp_elicitations": boolean; "request_permissions"?: boolean; "rules": boolean; "sandbox_approval": boolean; "skill_approval"?: boolean } })
export type AsyncUserInputQuestion = { "options"?: Array<string> | null; "title": string }
export type ByteRange = { "end": number; "start": number }
export type CapabilityRootLocation = ({ "environmentId": string; "path": string; "type": "environment" })
export type ClientInfo = { "name": string; "title"?: string | null; "version": string }
export type CodexErrorInfo = ("contextWindowExceeded" | "sessionBudgetExceeded" | "usageLimitExceeded" | "rateLimitExceeded" | "flexUnavailable" | "serverOverloaded" | "cyberPolicy" | "misalignmentPolicyViolation" | "tooManyDenials" | "internalServerError" | "unauthorized" | "badRequest" | "threadRollbackFailed" | "sandboxError" | "other") | ({ "httpConnectionFailed": { "httpStatusCode"?: number | null } }) | ({ "responseStreamConnectionFailed": { "httpStatusCode"?: number | null } }) | ({ "responseStreamDisconnected": { "httpStatusCode"?: number | null } }) | ({ "responseTooManyFailedAttempts": { "httpStatusCode"?: number | null } }) | ({ "activeTurnNotSteerable": { "turnKind": NonSteerableTurnKind } })
export type CollabAgentState = { "message"?: string | null; "status": CollabAgentStatus }
export type CollabAgentStatus = "pendingInit" | "running" | "interrupted" | "completed" | "errored" | "shutdown" | "notFound"
export type CollabAgentTool = "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent" | "sendMessage" | "followupTask" | "interruptAgent" | "listAgents"
export type CollabAgentToolCallStatus = "inProgress" | "completed" | "failed" | "interrupted"
export type CollaborationMode = { "mode": ModeKind; "settings": Settings }
export type CommandAction = ({ "command": string; "name": string; "path": LegacyAppPathString; "type": "read" }) | ({ "command": string; "path"?: string | null; "type": "listFiles" }) | ({ "command": string; "path"?: string | null; "query"?: string | null; "type": "search" }) | ({ "command": string; "type": "unknown" })
export type CommandExecutionSource = "agent" | "userShell" | "unifiedExecStartup" | "unifiedExecInteraction"
export type CommandExecutionStatus = "inProgress" | "completed" | "failed" | "declined"
export type ConfigurationReasoning = { "effort": ReasoningEffort }
export type ContentItem = ({ "text": string; "type": "input_text" }) | ({ "detail"?: (ImageDetail) | (null); "type": "input_image" } & (({ "image_url": string }) | ({ "file_id": string }))) | ({ "audio_url": string; "type": "input_audio" }) | ({ "text": string; "type": "output_text" })
export type CyberAccessProgram = "standard" | "daybreakBlue" | "daybreakRed"
export type DynamicToolCallOutputContentItem = ({ "text": string; "type": "inputText" }) | ({ "imageUrl": string; "type": "inputImage" }) | ({ "audioUrl": string; "type": "inputAudio" })
export type DynamicToolCallStatus = "inProgress" | "completed" | "failed"
export type DynamicToolNamespaceTool = ({ "deferLoading"?: boolean; "description": string; "inputSchema": unknown; "name": string; "type": "function" })
export type DynamicToolSpec = ({ "deferLoading"?: boolean; "description": string; "inputSchema": unknown; "name": string; "type": "function" }) | ({ "description": string; "name": string; "tools": Array<DynamicToolNamespaceTool>; "type": "namespace" })
export type FileUpdateChange = { "diff": string; "kind": PatchChangeKind; "path": string }
export type FunctionCallOutputBody = (string) | (Array<FunctionCallOutputContentItem>)
export type FunctionCallOutputContentItem = ({ "text": string; "type": "input_text" }) | ({ "detail"?: (ImageDetail) | (null); "type": "input_image" } & (({ "image_url": string }) | ({ "file_id": string }))) | ({ "audio_url": string; "type": "input_audio" }) | ({ "encrypted_content": string; "type": "encrypted_content" })
export type GitInfo = { "branch"?: string | null; "originUrl"?: string | null; "sha"?: string | null }
export type HookPromptFragment = { "hookRunId": string; "text": string }
export type ImageDetail = "auto" | "low" | "high" | "original"
export type ImageGenerationFailure = ({ "limitId": string; "resetsAt"?: number | null; "type": "usageLimitExceeded" })
export type InitializeCapabilities = { "experimentalApi"?: boolean; "explicitGatewayOauth"?: boolean; "extensions"?: Record<string, unknown> | null; "mcpServerOpenaiFormElicitation"?: boolean; "optOutNotificationMethods"?: Array<string> | null; "requestAttestation"?: boolean }
export type InitializeParams = { "capabilities"?: (InitializeCapabilities) | (null); "clientInfo": ClientInfo }
export type InitializeResponse = { "codexHome": (AbsolutePathBuf); "platformFamily": string; "platformOs": string; "userAgent": string }
export type InternalChatMessageMetadataPassthrough = { "turn_id"?: string | null }
export type LegacyAppPathString = string
export type LocalShellAction = ({ "command": Array<string>; "env"?: Record<string, string> | null; "timeout_ms"?: number | null; "type": "exec"; "user"?: string | null; "working_directory"?: string | null })
export type LocalShellStatus = "completed" | "in_progress" | "incomplete"
export type McpAppDisplayMode = "inline" | "fullscreen"
export type McpAppUi = { "preferredModelDisplayMode": McpAppDisplayMode; "resourceUri": string }
export type McpToolCallAppContext = { "actionName"?: string | null; "appName"?: string | null; "connectorId": string; "linkId"?: string | null; "resourceUri"?: string | null }
export type McpToolCallError = { "message": string }
export type McpToolCallResult = { "_meta"?: unknown; "content": Array<unknown>; "structuredContent"?: unknown }
export type McpToolCallStatus = "inProgress" | "completed" | "failed"
export type MemoryCitation = { "entries": Array<MemoryCitationEntry>; "threadIds": Array<string> }
export type MemoryCitationEntry = { "lineEnd": number; "lineStart": number; "note": string; "path": string }
export type MessagePhase = ("commentary") | ("final_answer")
export type MisalignmentErrorDetails = { "detailedExplanation"?: string | null; "errorType"?: string | null; "steer"?: (MisalignmentSteer) | (null) }
export type MisalignmentSteer = { "message": string }
export type ModeKind = "plan" | "default"
export type MultiAgentMode = ("explicitRequestOnly" | "proactive") | ({ "custom": string })
export type NetworkAccess = "restricted" | "enabled"
export type NonSteerableTurnKind = "review" | "compact"
export type PatchApplyStatus = "inProgress" | "completed" | "failed" | "declined"
export type PatchChangeKind = ({ "type": "add" }) | ({ "type": "delete" }) | ({ "move_path"?: string | null; "type": "update" })
export type Personality = "none" | "friendly" | "pragmatic"
export type ReasoningEffort = string
export type ReasoningItemContent = ({ "text": string; "type": "reasoning_text" }) | ({ "text": string; "type": "text" })
export type ReasoningItemReasoningSummary = ({ "text": string; "type": "summary_text" })
export type ReasoningSummary = ("auto" | "concise" | "detailed") | ("none")
export type ResponseItem = ({ "content": Array<ContentItem>; "id"?: string | null; "internal_chat_message_metadata_passthrough"?: (InternalChatMessageMetadataPassthrough) | (null); "phase"?: (MessagePhase) | (null); "role": string; "type": "message" }) | ({ "author": string; "content": Array<AgentMessageInputContent>; "id"?: string | null; "internal_chat_message_metadata_passthrough"?: (InternalChatMessageMetadataPassthrough) | (null); "recipient": string; "type": "agent_message" }) | ({ "content"?: Array<ReasoningItemContent> | null; "encrypted_content"?: string | null; "id"?: string | null; "internal_chat_message_metadata_passthrough"?: (InternalChatMessageMetadataPassthrough) | (null); "summary": Array<ReasoningItemReasoningSummary>; "type": "reasoning" }) | ({ "action": LocalShellAction; "call_id"?: string | null; "id"?: string | null; "internal_chat_message_metadata_passthrough"?: (InternalChatMessageMetadataPassthrough) | (null); "status": LocalShellStatus; "type": "local_shell_call" }) | ({ "arguments": string; "call_id": string; "encrypted_function_args"?: Array<string> | null; "id"?: string | null; "internal_chat_message_metadata_passthrough"?: (InternalChatMessageMetadataPassthrough) | (null); "name": string; "namespace"?: string | null; "type": "function_call" }) | ({ "arguments": unknown; "call_id"?: string | null; "execution": string; "id"?: string | null; "internal_chat_message_metadata_passthrough"?: (InternalChatMessageMetadataPassthrough) | (null); "status"?: string | null; "type": "tool_search_call" }) | ({ "call_id"?: string | null; "id"?: string | null; "internal_chat_message_metadata_passthrough"?: (InternalChatMessageMetadataPassthrough) | (null); "name"?: string | null; "namespace"?: string | null; "output": FunctionCallOutputBody; "type": "function_call_output" }) | ({ "call_id": string; "id"?: string | null; "input": string; "internal_chat_message_metadata_passthrough"?: (InternalChatMessageMetadataPassthrough) | (null); "name": string; "namespace"?: string | null; "status"?: string | null; "type": "custom_tool_call" }) | ({ "call_id": string; "id"?: string | null; "internal_chat_message_metadata_passthrough"?: (InternalChatMessageMetadataPassthrough) | (null); "name"?: string | null; "output": FunctionCallOutputBody; "type": "custom_tool_call_output" }) | ({ "call_id"?: string | null; "execution": string; "id"?: string | null; "internal_chat_message_metadata_passthrough"?: (InternalChatMessageMetadataPassthrough) | (null); "status": string; "tools": Array<unknown>; "type": "tool_search_output" }) | ({ "action"?: (ResponsesApiWebSearchAction) | (null); "id"?: string | null; "internal_chat_message_metadata_passthrough"?: (InternalChatMessageMetadataPassthrough) | (null); "status"?: string | null; "type": "web_search_call" }) | ({ "id"?: string | null; "internal_chat_message_metadata_passthrough"?: (InternalChatMessageMetadataPassthrough) | (null); "result": string; "revised_prompt"?: string | null; "status": string; "type": "image_generation_call" }) | ({ "encrypted_content": string; "id"?: string | null; "internal_chat_message_metadata_passthrough"?: (InternalChatMessageMetadataPassthrough) | (null); "type": "compaction" }) | ({ "reasoning": ConfigurationReasoning; "type": "configuration_update" }) | ({ "type": "compaction_trigger" }) | ({ "encrypted_content"?: string | null; "id"?: string | null; "internal_chat_message_metadata_passthrough"?: (InternalChatMessageMetadataPassthrough) | (null); "type": "context_compaction" }) | ({ "type": "other" })
export type ResponsesApiWebSearchAction = ({ "queries"?: Array<string> | null; "query"?: string | null; "type": "search" }) | ({ "type": "open_page"; "url"?: string | null }) | ({ "pattern"?: string | null; "type": "find_in_page"; "url"?: string | null }) | ({ "type": "other" })
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access"
export type SandboxPolicy = ({ "type": "dangerFullAccess" }) | ({ "networkAccess"?: boolean; "type": "readOnly" }) | ({ "networkAccess"?: (NetworkAccess); "type": "externalSandbox" }) | ({ "excludeSlashTmp"?: boolean; "excludeTmpdirEnvVar"?: boolean; "networkAccess"?: boolean; "type": "workspaceWrite"; "writableRoots"?: Array<AbsolutePathBuf> })
export type SelectedCapabilityRoot = { "id": string; "location": (CapabilityRootLocation) }
export type SessionSource = ("cli" | "vscode" | "exec" | "appServer" | "unknown") | ({ "custom": string }) | ({ "subAgent": SubAgentSource })
export type Settings = { "developer_instructions"?: string | null; "model": string; "reasoning_effort"?: (ReasoningEffort) | (null) }
export type SortDirection = "asc" | "desc"
export type SubAgentActivityKind = "started" | "interacted" | "interrupted" | "completed"
export type SubAgentSource = ("review" | "compact" | "memory_consolidation") | ({ "thread_spawn": { "agent_nickname"?: string | null; "agent_path"?: (AgentPath) | (null); "agent_role"?: string | null; "depth": number; "parent_thread_id": ThreadId } }) | ({ "other": string })
export type TextElement = { "byteRange": (ByteRange); "placeholder"?: string | null }
export type Thread = { "agentNickname"?: string | null; "agentRole"?: string | null; "canAcceptDirectInput"?: boolean | null; "cliVersion": string; "createdAt": number; "cwd": (AbsolutePathBuf); "daybreakEnabled"?: boolean | null; "environments"?: Array<ThreadEnvironment> | null; "ephemeral": boolean; "extra"?: (ThreadExtra) | (null); "forkedFromId"?: string | null; "gitInfo"?: (GitInfo) | (null); "historyMode"?: (ThreadHistoryMode); "id": string; "model"?: string | null; "modelProvider": string; "name"?: string | null; "originator"?: string | null; "parentThreadId"?: string | null; "path"?: string | null; "preview": string; "projectId": string | null; "reasoningEffort"?: (ReasoningEffort) | (null); "recencyAt"?: number | null; "section"?: (ThreadSection) | (null); "sectionEnteredAt"?: number | null; "sessionId": string; "source": (SessionSource); "status": (ThreadStatus); "threadSource"?: (ThreadSource) | (null); "turns": Array<Turn>; "updatedAt": number }
export type ThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput"
export type ThreadEnvironment = { "cwd": LegacyAppPathString; "environmentId": string; "runtimeWorkspaceRoots": Array<LegacyAppPathString> }
export type ThreadExtra = Record<string, unknown>
export type ThreadGoal = { "createdAt": number; "objective": string; "status": ThreadGoalStatus; "threadId": string; "timeUsedSeconds": number; "tokenBudget"?: number | null; "tokensUsed": number; "updatedAt": number }
export type ThreadGoalClearParams = { "threadId": string }
export type ThreadGoalGetParams = { "threadId": string }
export type ThreadGoalSetParams = { "objective"?: string | null; "status"?: (ThreadGoalStatus) | (null); "threadId": string; "tokenBudget"?: number | null }
export type ThreadGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete"
export type ThreadHistoryMode = "legacy" | "paginated"
export type ThreadId = string
export type ThreadItem = ({ "clientId"?: string | null; "content": Array<UserInput>; "id": string; "type": "userMessage" }) | ({ "fragments": Array<HookPromptFragment>; "id": string; "type": "hookPrompt" }) | ({ "delivery"?: (AgentMessageDelivery) | (null); "id": string; "memoryCitation"?: (MemoryCitation) | (null); "phase"?: (MessagePhase) | (null); "questions"?: Array<AsyncUserInputQuestion> | null; "text": string; "type": "agentMessage" }) | ({ "id": string; "name": string; "namespace"?: string | null; "output": FunctionCallOutputBody; "type": "functionCallOutput" }) | ({ "id": string; "text": string; "type": "plan" }) | ({ "content"?: Array<string>; "id": string; "summary"?: Array<string>; "type": "reasoning" }) | ({ "aggregatedOutput"?: string | null; "command": string; "commandActions": Array<CommandAction>; "cwd": (LegacyAppPathString); "durationMs"?: number | null; "exitCode"?: number | null; "id": string; "pluginId"?: string | null; "processId"?: string | null; "scriptPath"?: string | null; "source"?: (CommandExecutionSource); "status": CommandExecutionStatus; "type": "commandExecution" }) | ({ "changes": Array<FileUpdateChange>; "id": string; "status": PatchApplyStatus; "type": "fileChange" }) | ({ "appContext"?: (McpToolCallAppContext) | (null); "arguments": unknown; "durationMs"?: number | null; "error"?: (McpToolCallError) | (null); "id": string; "mcpAppResourceUri"?: string | null; "mcpAppUi"?: (McpAppUi) | (null); "pluginId"?: string | null; "readOnlyHint"?: boolean | null; "result"?: (McpToolCallResult) | (null); "server": string; "status": McpToolCallStatus; "tool": string; "type": "mcpToolCall" }) | ({ "arguments": unknown; "contentItems"?: Array<DynamicToolCallOutputContentItem> | null; "durationMs"?: number | null; "id": string; "namespace"?: string | null; "status": DynamicToolCallStatus; "success"?: boolean | null; "tool": string; "type": "dynamicToolCall" }) | ({ "agentsStates": Record<string, CollabAgentState>; "id": string; "model"?: string | null; "prompt"?: string | null; "reasoningEffort"?: (ReasoningEffort) | (null); "receiverThreadIds": Array<string>; "senderThreadId": string; "status": (CollabAgentToolCallStatus); "tool": (CollabAgentTool); "type": "collabAgentToolCall" }) | ({ "agentPath": string; "agentThreadId": string; "id": string; "kind": SubAgentActivityKind; "type": "subAgentActivity" }) | ({ "action"?: (WebSearchAction) | (null); "id": string; "query": string; "results"?: Array<unknown> | null; "type": "webSearch" }) | ({ "id": string; "path": LegacyAppPathString; "type": "imageView" }) | ({ "durationMs": number; "id": string; "type": "sleep" }) | ({ "failure"?: (ImageGenerationFailure) | (null); "id": string; "result": string; "revisedPrompt"?: string | null; "savedPath"?: (AbsolutePathBuf) | (null); "status": string; "transparentBackground"?: boolean | null; "type": "imageGeneration" }) | ({ "id": string; "review": string; "type": "enteredReviewMode" }) | ({ "id": string; "review": string; "type": "exitedReviewMode" }) | ({ "id": string; "type": "contextCompaction" })
export type ThreadResumeInitialTurnsPageParams = { "itemsView"?: (TurnItemsView) | (null); "limit"?: number | null; "sortDirection"?: (SortDirection) | (null) }
export type ThreadResumeParams = { "approvalPolicy"?: (AskForApproval) | (null); "approvalsReviewer"?: (ApprovalsReviewer) | (null); "baseInstructions"?: string | null; "config"?: Record<string, unknown> | null; "cwd"?: string | null; "developerInstructions"?: string | null; "excludeTurns"?: boolean; "history"?: Array<ResponseItem> | null; "initialTurnsPage"?: (ThreadResumeInitialTurnsPageParams) | (null); "model"?: string | null; "modelProvider"?: string | null; "path"?: string | null; "permissions"?: string | null; "personality"?: (Personality) | (null); "runtimeWorkspaceRoots"?: Array<AbsolutePathBuf> | null; "sandbox"?: (SandboxMode) | (null); "serviceTier"?: string | null; "threadId": string }
export type ThreadResumeResponse = { "activePermissionProfile"?: (ActivePermissionProfile) | (null); "approvalPolicy": AskForApproval; "approvalsReviewer": (ApprovalsReviewer); "collaborationMode"?: (CollaborationMode) | (null); "cwd": AbsolutePathBuf; "disabledPluginIds"?: Array<string>; "initialTurnsPage"?: (TurnsPage) | (null); "instructionSources"?: Array<LegacyAppPathString>; "itemsBackwardsCursor"?: string | null; "model": string; "modelProvider": string; "multiAgentMode"?: (MultiAgentMode); "reasoningEffort"?: (ReasoningEffort) | (null); "runtimeWorkspaceRoots"?: Array<AbsolutePathBuf>; "sandbox": (SandboxPolicy); "serviceTier"?: string | null; "thread": Thread; "turnsBackwardsCursor"?: string | null }
export type ThreadSection = { "appearance"?: (ThreadSectionAppearance) | (null); "id": string; "name": string }
export type ThreadSectionAppearance = { "color"?: string | null; "icon"?: string | null }
export type ThreadSource = string
export type ThreadStartParams = { "allowProviderModelFallback"?: boolean; "approvalPolicy"?: (AskForApproval) | (null); "approvalsReviewer"?: (ApprovalsReviewer) | (null); "baseInstructions"?: string | null; "config"?: Record<string, unknown> | null; "cwd"?: string | null; "daybreakEnabled"?: boolean | null; "developerInstructions"?: string | null; "dynamicTools"?: Array<DynamicToolSpec> | null; "environments"?: Array<TurnEnvironmentParams> | null; "ephemeral"?: boolean | null; "experimentalRawEvents"?: boolean; "historyMode"?: (ThreadHistoryMode) | (null); "mockExperimentalField"?: string | null; "model"?: string | null; "modelProvider"?: string | null; "multiAgentMode"?: (MultiAgentMode) | (null); "permissions"?: string | null; "personality"?: (Personality) | (null); "projectId"?: string | null; "runtimeWorkspaceRoots"?: Array<AbsolutePathBuf> | null; "sandbox"?: (SandboxMode) | (null); "selectedCapabilityRoots"?: Array<SelectedCapabilityRoot> | null; "serviceName"?: string | null; "serviceTier"?: string | null; "sessionStartSource"?: (ThreadStartSource) | (null); "threadSource"?: (ThreadSource) | (null) }
export type ThreadStartResponse = { "activePermissionProfile"?: (ActivePermissionProfile) | (null); "approvalPolicy": AskForApproval; "approvalsReviewer": (ApprovalsReviewer); "cwd": AbsolutePathBuf; "disabledPluginIds"?: Array<string>; "instructionSources"?: Array<LegacyAppPathString>; "model": string; "modelProvider": string; "multiAgentMode"?: (MultiAgentMode); "reasoningEffort"?: (ReasoningEffort) | (null); "runtimeWorkspaceRoots"?: Array<AbsolutePathBuf>; "sandbox": (SandboxPolicy); "serviceTier"?: string | null; "thread": Thread }
export type ThreadStartSource = "startup" | "clear"
export type ThreadStatus = ({ "type": "notLoaded" }) | ({ "type": "idle" }) | ({ "type": "systemError" }) | ({ "activeFlags": Array<ThreadActiveFlag>; "type": "active" })
export type Turn = { "completedAt"?: number | null; "durationMs"?: number | null; "error"?: (TurnError) | (null); "id": string; "items": Array<ThreadItem>; "itemsView"?: (TurnItemsView); "startedAt"?: number | null; "status": TurnStatus }
export type TurnCompletedNotification = { "threadId": string; "turn": Turn }
export type TurnEnvironmentParams = { "cwd": LegacyAppPathString; "environmentId": string; "runtimeWorkspaceRoots"?: Array<LegacyAppPathString> | null }
export type TurnError = { "additionalDetails"?: string | null; "codexErrorInfo"?: (CodexErrorInfo) | (null); "message": string; "misalignment"?: (MisalignmentErrorDetails) | (null) }
export type TurnInterruptParams = { "threadId": string; "turnId": string }
export type TurnItemsView = ("notLoaded") | ("summary") | ("full")
export type TurnStartParams = { "additionalContext"?: Record<string, AdditionalContextEntry> | null; "approvalPolicy"?: (AskForApproval) | (null); "approvalsReviewer"?: (ApprovalsReviewer) | (null); "clientUserMessageId"?: string | null; "collaborationMode"?: (CollaborationMode) | (null); "cwd"?: string | null; "cyberAccessProgram"?: (CyberAccessProgram) | (null); "disabledPluginIds"?: Array<string> | null; "effort"?: (ReasoningEffort) | (null); "environments"?: Array<TurnEnvironmentParams> | null; "input": Array<UserInput>; "model"?: string | null; "multiAgentMode"?: (MultiAgentMode) | (null); "outputSchema"?: unknown; "permissions"?: string | null; "personality"?: (Personality) | (null); "responsesapiClientMetadata"?: Record<string, string> | null; "runtimeWorkspaceRoots"?: Array<AbsolutePathBuf> | null; "sandboxPolicy"?: (SandboxPolicy) | (null); "serviceTier"?: string | null; "serviceTierForTurn"?: string | null; "summary"?: (ReasoningSummary) | (null); "threadId": string; "toolOutput"?: (TurnToolOutput) | (null); "turnTrigger"?: string | null }
export type TurnStartResponse = { "turn": Turn }
export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress"
export type TurnSteerParams = { "additionalContext"?: Record<string, AdditionalContextEntry> | null; "clientUserMessageId"?: string | null; "expectedTurnId": string; "input": Array<UserInput>; "responsesapiClientMetadata"?: Record<string, string> | null; "threadId": string }
export type TurnSteerResponse = { "turnId": string }
export type TurnToolOutput = { "name": string; "namespace"?: string | null; "output": FunctionCallOutputBody }
export type TurnsPage = { "backwardsCursor"?: string | null; "data": Array<Turn>; "nextCursor"?: string | null }
export type UserInput = ({ "text": string; "text_elements"?: Array<TextElement>; "type": "text" }) | ({ "detail"?: (ImageDetail) | (null); "type": "image" } & (({ "url": string }) | ({ "fileId": string }))) | ({ "detail"?: (ImageDetail) | (null); "path": string; "type": "localImage" }) | ({ "type": "audio"; "url": string }) | ({ "path": string; "type": "localAudio" }) | ({ "name": string; "path": string; "type": "skill" }) | ({ "name": string; "path": string; "type": "mention" })
export type WebSearchAction = ({ "queries"?: Array<string> | null; "query"?: string | null; "type": "search" }) | ({ "type": "openPage"; "url"?: string | null }) | ({ "pattern"?: string | null; "type": "findInPage"; "url"?: string | null }) | ({ "type": "other" })

export interface CodexRequestParams {
  "initialize": InitializeParams
  "thread/goal/clear": ThreadGoalClearParams
  "thread/goal/get": ThreadGoalGetParams
  "thread/goal/set": ThreadGoalSetParams
  "thread/resume": ThreadResumeParams
  "thread/start": ThreadStartParams
  "turn/interrupt": TurnInterruptParams
  "turn/start": TurnStartParams
  "turn/steer": TurnSteerParams
}
