import { compressionMiddleware } from "./compression"
import { catchAsyncErrors, type UseFn } from "./http"
import { createHubProxyHandler } from "./hub/proxy"
import { registerAgentPromptRoutes } from "./routes/agent-prompts"
import { registerAskUserRoutes } from "./routes/ask-user"
import { registerAgentRuntimeRoutes } from "./routes/agent-runtime"
import { registerCopilotHistoryRoutes } from "./routes/copilot-history"
import { registerSessionManageRoutes } from "./routes/session-manage"
import { registerSessionNewRoutes } from "./routes/session-new"
import { registerSessionSendRoutes } from "./routes/session-send"
import { registerCodexThreadRoutes } from "./routes/codex-threads"
import { registerConfigBrowserRoutes } from "./routes/config-browser"
import { registerConfigRoutes } from "./routes/config"
import { registerDeviceRoutes } from "./routes/devices"
import { registerEditorRoutes } from "./routes/editor"
import { registerFileContentRoutes } from "./routes/file-content"
import { registerFileWatchRoutes } from "./routes/files-watch"
import { registerFileRoutes } from "./routes/files"
import { registerGitDiffRoutes } from "./routes/git-diff"
import { registerGitStatusRoutes } from "./routes/git-status"
import { registerProjectIconRoutes } from "./routes/project-icon"
import { registerHelloRoutes, type HubMode } from "./routes/hello"
import { registerLocalFileRoutes } from "./routes/local-file"
import { registerMcpRoutes } from "./routes/mcp"
import { registerMissionControlRoutes } from "./routes/mission-control"
import { registerModelRoutes } from "./routes/models"
import { registerNotificationRoutes } from "./routes/notifications"
import { registerPerformanceRoutes } from "./routes/performance"
import { registerPermissionRoutes } from "./routes/permissions"
import { registerPortRoutes } from "./routes/ports"
import { registerProjectFileContentRoutes } from "./routes/project-file"
import { registerProjectFileRoutes } from "./routes/project-files"
import { registerProjectRoutes } from "./routes/projects"
import { registerProviderUpdateRoutes } from "./routes/provider-updates"
import { registerAgentExecutableRoutes } from "./routes/agent-executable"
import { registerScriptRoutes } from "./routes/scripts"
import { registerSessionConfigRoutes } from "./routes/session-config"
import { registerSessionContextRoutes } from "./routes/session-context"
import { registerSessionFileChangesRoutes } from "./routes/session-file-changes"
import { registerSessionStatusRoutes } from "./routes/session-status"
import { registerShareGuestRoutes } from "./routes/share-guest"
import { registerShareRoutes } from "./routes/shares"
import { registerSlashSuggestionRoutes } from "./routes/slash-suggestions"
import { registerTeamAdminRoutes } from "./routes/team"
import { registerTeamSessionRoutes } from "./routes/team-session"
import { registerTeamRoutes } from "./routes/teams"
import { registerUndoRoutes } from "./routes/undo"
import { registerUsageCostRoutes } from "./routes/usage-cost"
import { registerUsageRoutes } from "./routes/usage"
import { registerWorkflowRoutes } from "./routes/workflows"
import { registerWorktreeRoutes } from "./routes/worktrees"

export interface ApiRouteContext {
  mode: HubMode
}

interface ApiRouteDefinition {
  readonly id: string
  readonly register: (use: UseFn, context: ApiRouteContext) => void
}

function apiRoute(
  id: string,
  register: (use: UseFn) => void,
): ApiRouteDefinition {
  return {
    id,
    register: (use) => register(use),
  }
}

/**
 * Canonical API middleware order shared by Vite, Electron, and standalone.
 *
 * This preserves the original Vite development order. Order is intentional:
 * public device discovery and the hub proxy precede performance monitoring,
 * followed by configuration, domain APIs, and agent runtime controls.
 * Add every new route group here so all server entry points stay in parity.
 *
 * Ids name the concern, not an agent: `session-send`, `session-new` and
 * `session-manage` serve all three CLIs, and only a genuinely single-agent
 * capability (`codex-threads`, `copilot-history`) may carry an agent's name.
 * Every id also has to exist in `team/policy.ts` — an unlisted path falls
 * through to the admin default and silently locks members out.
 */
export const API_ROUTE_REGISTRY = [
  { id: "hello", register: registerHelloRoutes },
  apiRoute("devices", registerDeviceRoutes),
  {
    id: "hub",
    register: (use: UseFn) => use("/hub", createHubProxyHandler()),
  },
  apiRoute("performance", registerPerformanceRoutes),
  apiRoute("config", registerConfigRoutes),
  apiRoute("team-admin", registerTeamAdminRoutes),
  apiRoute("projects", registerProjectRoutes),
  apiRoute("session-send", registerSessionSendRoutes),
  apiRoute("session-new", registerSessionNewRoutes),
  apiRoute("session-manage", registerSessionManageRoutes),
  apiRoute("ports", registerPortRoutes),
  apiRoute("teams", registerTeamRoutes),
  apiRoute("team-session", registerTeamSessionRoutes),
  apiRoute("workflows", registerWorkflowRoutes),
  apiRoute("undo", registerUndoRoutes),
  apiRoute("files", registerFileRoutes),
  apiRoute("files-watch", registerFileWatchRoutes),
  apiRoute("session-file-changes", registerSessionFileChangesRoutes),
  apiRoute("session-config", registerSessionConfigRoutes),
  apiRoute("session-context", registerSessionContextRoutes),
  apiRoute("session-status", registerSessionStatusRoutes),
  apiRoute("shares", registerShareRoutes),
  apiRoute("share-guest", registerShareGuestRoutes),
  apiRoute("editor", registerEditorRoutes),
  apiRoute("worktrees", registerWorktreeRoutes),
  apiRoute("usage", registerUsageRoutes),
  apiRoute("usage-cost", registerUsageCostRoutes),
  apiRoute("slash-suggestions", registerSlashSuggestionRoutes),
  apiRoute("config-browser", registerConfigBrowserRoutes),
  apiRoute("local-file", registerLocalFileRoutes),
  apiRoute("file-content", registerFileContentRoutes),
  apiRoute("project-files", registerProjectFileRoutes),
  apiRoute("project-file", registerProjectFileContentRoutes),
  apiRoute("git-status", registerGitStatusRoutes),
  apiRoute("project-icon", registerProjectIconRoutes),
  apiRoute("git-diff", registerGitDiffRoutes),
  apiRoute("mcp", registerMcpRoutes),
  apiRoute("notifications", registerNotificationRoutes),
  apiRoute("scripts", registerScriptRoutes),
  apiRoute("permissions", registerPermissionRoutes),
  apiRoute("mission-control", registerMissionControlRoutes),
  apiRoute("ask-user", registerAskUserRoutes),
  apiRoute("copilot-history", registerCopilotHistoryRoutes),
  apiRoute("agent-prompts", registerAgentPromptRoutes),
  apiRoute("models", registerModelRoutes),
  apiRoute("codex-threads", registerCodexThreadRoutes),
  apiRoute("agent-runtime", registerAgentRuntimeRoutes),
  apiRoute("provider-updates", registerProviderUpdateRoutes),
  apiRoute("agent-executable", registerAgentExecutableRoutes),
] as const satisfies readonly ApiRouteDefinition[]

export function registerApiRoutes(use: UseFn, context: ApiRouteContext): void {
  const safeUse: UseFn = (path, handler) => use(path, catchAsyncErrors(handler))
  // Registered before every route so single-shot JSON/text responses gzip for
  // remote clients (tunnel/LAN); streaming responses pass through untouched.
  safeUse("/api", compressionMiddleware)
  for (const route of API_ROUTE_REGISTRY) {
    route.register(safeUse, context)
  }
}
