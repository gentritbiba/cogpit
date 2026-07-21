import { catchAsyncErrors, type UseFn } from "./http"
import { createHubProxyHandler } from "./hub/proxy"
import { registerAskUserRoutes } from "./routes/ask-user"
import { registerClaudeManageRoutes } from "./routes/claude-manage"
import { registerClaudeNewRoutes } from "./routes/claude-new"
import { registerClaudeRuntimeRoutes } from "./routes/claude-runtime"
import { registerClaudeRoutes } from "./routes/claude"
import { registerCodexRuntimeRoutes } from "./routes/codex-runtime"
import { registerConfigBrowserRoutes } from "./routes/config-browser"
import { registerConfigRoutes } from "./routes/config"
import { registerDeviceRoutes } from "./routes/devices"
import { registerEditorRoutes } from "./routes/editor"
import { registerFileContentRoutes } from "./routes/file-content"
import { registerFileWatchRoutes } from "./routes/files-watch"
import { registerFileRoutes } from "./routes/files"
import { registerGitStatusRoutes } from "./routes/git-status"
import { registerHelloRoutes, type HubMode } from "./routes/hello"
import { registerLocalFileRoutes } from "./routes/local-file"
import { registerMcpRoutes } from "./routes/mcp"
import { registerModelRoutes } from "./routes/models"
import { registerNotifyRoutes } from "./routes/notify"
import { registerPerformanceRoutes } from "./routes/performance"
import { registerPermissionRoutes } from "./routes/permissions"
import { registerPortRoutes } from "./routes/ports"
import { registerProjectFileContentRoutes } from "./routes/project-file"
import { registerProjectFileRoutes } from "./routes/project-files"
import { registerProjectRoutes } from "./routes/projects"
import { registerScriptRoutes } from "./routes/scripts"
import { registerSessionContextRoutes } from "./routes/session-context"
import { registerSessionFileChangesRoutes } from "./routes/session-file-changes"
import { registerSlashSuggestionRoutes } from "./routes/slash-suggestions"
import { registerTeamSessionRoutes } from "./routes/team-session"
import { registerTeamRoutes } from "./routes/teams"
import { registerUndoRoutes } from "./routes/undo"
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
 * followed by configuration, domain APIs, and provider runtime controls.
 * Add every new route group here so all server entry points stay in parity.
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
  apiRoute("projects", registerProjectRoutes),
  apiRoute("claude", registerClaudeRoutes),
  apiRoute("claude-new", registerClaudeNewRoutes),
  apiRoute("claude-manage", registerClaudeManageRoutes),
  apiRoute("ports", registerPortRoutes),
  apiRoute("teams", registerTeamRoutes),
  apiRoute("team-session", registerTeamSessionRoutes),
  apiRoute("workflows", registerWorkflowRoutes),
  apiRoute("undo", registerUndoRoutes),
  apiRoute("files", registerFileRoutes),
  apiRoute("files-watch", registerFileWatchRoutes),
  apiRoute("session-file-changes", registerSessionFileChangesRoutes),
  apiRoute("session-context", registerSessionContextRoutes),
  apiRoute("editor", registerEditorRoutes),
  apiRoute("worktrees", registerWorktreeRoutes),
  apiRoute("usage", registerUsageRoutes),
  apiRoute("slash-suggestions", registerSlashSuggestionRoutes),
  apiRoute("config-browser", registerConfigBrowserRoutes),
  apiRoute("local-file", registerLocalFileRoutes),
  apiRoute("file-content", registerFileContentRoutes),
  apiRoute("project-files", registerProjectFileRoutes),
  apiRoute("project-file", registerProjectFileContentRoutes),
  apiRoute("git-status", registerGitStatusRoutes),
  apiRoute("mcp", registerMcpRoutes),
  apiRoute("notify", registerNotifyRoutes),
  apiRoute("scripts", registerScriptRoutes),
  apiRoute("permissions", registerPermissionRoutes),
  apiRoute("ask-user", registerAskUserRoutes),
  apiRoute("models", registerModelRoutes),
  apiRoute("codex-runtime", registerCodexRuntimeRoutes),
  apiRoute("claude-runtime", registerClaudeRuntimeRoutes),
] as const satisfies readonly ApiRouteDefinition[]

export function registerApiRoutes(use: UseFn, context: ApiRouteContext): void {
  const safeUse: UseFn = (path, handler) => use(path, catchAsyncErrors(handler))
  for (const route of API_ROUTE_REGISTRY) {
    route.register(safeUse, context)
  }
}
