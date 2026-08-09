export type PolicyRequirement = "public" | "authed" | "admin"

export interface PolicyRule {
  prefix: string
  methods?: string[]
  requires: PolicyRequirement
}

function authed(...prefixes: string[]): PolicyRule[] {
  return prefixes.map((prefix) => ({ prefix, requires: "authed" }))
}

function admin(...prefixes: string[]): PolicyRule[] {
  return prefixes.map((prefix) => ({ prefix, requires: "admin" }))
}

/**
 * Team-edition access requirements, one entry per id in API_ROUTE_REGISTRY
 * (enforced both ways by api-routes.test.ts). Prefixes mirror the paths each
 * route module actually mounts; requirementFor falls back to "admin" for
 * anything unlisted, so a forgotten path locks down instead of leaking.
 */
export const ROUTE_POLICIES: Record<string, PolicyRule[]> = {
  hello: [{ prefix: "/api/hello", requires: "public" }],
  devices: admin("/api/hub/devices"),
  hub: authed("/hub/"),
  // The bare use("/api", requestMonitor) mount is a pass-through metrics tap,
  // not a request surface — listing it would defeat the fail-safe default.
  performance: [
    ...admin("/api/system-processes"),
    ...authed("/api/performance"),
  ],
  config: [
    { prefix: "/api/config", methods: ["POST"], requires: "admin" },
    ...authed(
      "/api/config",
      "/api/config/validate",
      "/api/network-info",
      "/api/auth/verify",
      "/api/auth/session",
      "/api/auth/logout",
      "/api/connected-devices",
    ),
  ],
  projects: authed(
    "/api/projects",
    "/api/codex-subagents",
    "/api/sessions",
    "/api/active-sessions",
    "/api/find-session",
  ),
  claude: authed("/api/send-message"),
  "claude-new": authed(
    "/api/new-session",
    "/api/create-and-send",
    "/api/branch-session",
  ),
  "claude-manage": [
    ...admin("/api/kill-all", "/api/kill-process"),
    ...authed(
      "/api/claude/settings",
      "/api/claude/checkpoints",
      "/api/claude/tasks",
      "/api/interrupt-session",
      "/api/stop-session",
      "/api/delete-session",
      "/api/running-processes",
    ),
  ],
  ports: [
    ...admin("/api/kill-port"),
    ...authed("/api/check-ports", "/api/background-tasks", "/api/background-agents"),
  ],
  teams: authed("/api/teams", "/api/team-detail", "/api/team-watch", "/api/team-message"),
  "team-session": authed("/api/session-team", "/api/team-member-session"),
  workflows: authed(
    "/api/workflows",
    "/api/workflow-detail",
    "/api/workflow-watch",
    "/api/workflow-stop",
  ),
  undo: authed(
    "/api/undo-state",
    "/api/undo/apply",
    "/api/undo/truncate-jsonl",
    "/api/undo/append-jsonl",
    "/api/undo/transaction",
  ),
  files: authed("/api/check-files-exist"),
  "files-watch": authed("/api/task-output", "/api/watch"),
  "session-file-changes": authed("/api/session-file-changes"),
  "session-config": authed("/api/session-config"),
  "session-context": authed("/api/session-context"),
  editor: admin("/api/reveal-in-folder", "/api/open-terminal", "/api/open-in-editor"),
  worktrees: authed("/api/worktrees"),
  usage: admin("/api/usage"),
  "slash-suggestions": authed("/api/slash-suggestions", "/api/expand-command"),
  "config-browser": [
    { prefix: "/api/config-browser", methods: ["GET"], requires: "authed" },
    { prefix: "/api/config-browser", requires: "admin" },
  ],
  "local-file": authed("/api/local-file"),
  "file-content": authed("/api/file-content"),
  "project-files": authed("/api/project-files"),
  "project-file": authed("/api/project-file"),
  "git-status": authed("/api/git-status"),
  mcp: authed("/api/mcp-servers"),
  notify: authed("/api/notify"),
  scripts: authed("/api/scripts"),
  permissions: authed("/api/permissions"),
  "mission-control": authed("/api/mission-control"),
  "ask-user": authed("/api/user-questions", "/api/ask-user-answer"),
  models: authed("/api/models"),
  "codex-runtime": authed("/api/codex/runtime", "/api/codex/goals", "/api/codex/threads"),
  "claude-runtime": authed("/api/claude/runtime"),
}

const ALL_RULES: readonly PolicyRule[] = Object.values(ROUTE_POLICIES).flat()

/**
 * Resolve the requirement for a query-stripped, lowercased path. Longest
 * matching prefix wins; at equal prefix length a method-specific rule beats a
 * method-agnostic one. No match at all means "admin".
 */
export function requirementFor(path: string, method: string): PolicyRequirement {
  let best: PolicyRule | null = null
  for (const rule of ALL_RULES) {
    if (!path.startsWith(rule.prefix)) continue
    if (rule.methods && !rule.methods.includes(method)) continue
    if (
      !best
      || rule.prefix.length > best.prefix.length
      || (rule.prefix.length === best.prefix.length && rule.methods && !best.methods)
    ) {
      best = rule
    }
  }
  return best?.requires ?? "admin"
}
