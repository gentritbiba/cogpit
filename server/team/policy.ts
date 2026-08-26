import { prefixMatches } from "../http"

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
  devices: [
    { prefix: "/api/hub/devices", methods: ["GET"], requires: "authed" },
    { prefix: "/api/hub/devices", requires: "admin" },
  ],
  hub: authed("/hub/"),
  // The bare use("/api", requestMonitor) mount is a pass-through metrics tap,
  // not a request surface — listing it would defeat the fail-safe default.
  performance: [
    ...admin("/api/system-processes"),
    ...authed("/api/performance"),
  ],
  config: [
    { prefix: "/api/config", methods: ["GET"], requires: "authed" },
    { prefix: "/api/config", requires: "admin" },
    ...admin("/api/config/validate"),
    // Login: a user has no principal until this call succeeds, and
    // PUBLIC_PATHS already lets it past authMiddleware unauthenticated. The
    // route itself verifies the credential.
    { prefix: "/api/auth/verify", requires: "public" },
    ...authed(
      "/api/network-info",
      "/api/auth/session",
      "/api/auth/logout",
      "/api/connected-devices",
    ),
  ],
  // Longest prefix puts bootstrap above the /api/team/ admin catch-all; the
  // "public" is inert protection — authMiddleware already gates bootstrap by
  // the zero-users window, authz just must not demand a principal for it.
  "team-admin": [
    { prefix: "/api/me", requires: "authed" },
    { prefix: "/api/team/bootstrap", requires: "public" },
    { prefix: "/api/team/", requires: "admin" },
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
    ...admin("/api/kill-all", "/api/kill-process", "/api/claude/checkpoints"),
    ...authed(
      "/api/claude/settings",
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
  // These routes accept caller-selected host paths and can read, overwrite, or
  // delete files. Until project roots are server-owned and path-confined, they
  // are administrative host-management capabilities, not member workspace APIs.
  undo: admin(
    "/api/undo-state",
    "/api/undo/apply",
    "/api/undo/truncate-jsonl",
    "/api/undo/append-jsonl",
    "/api/undo/transaction",
  ),
  files: admin("/api/check-files-exist"),
  "files-watch": authed("/api/task-output", "/api/watch"),
  // Returns exact before/after content and absolute host paths parsed from the
  // shared transcript, so it belongs to the same hostFiles boundary as diffs.
  //
  // A share guest reaches this route and a non-admin team member does not, and
  // that inversion is deliberate rather than a gap. A member is bounded by team
  // governance — an admin gave them an account, not a decision about any one
  // session. A guest was invited into exactly one session by an admin who chose
  // that session, and is already reading the tool calls in its transcript,
  // absolute paths and all. Withholding the diffs would hide nothing that the
  // transcript does not already show.
  "session-file-changes": admin("/api/session-file-changes"),
  "session-config": authed("/api/session-config"),
  "session-context": authed("/api/session-context"),
  "session-status": authed("/api/session-status"),
  // Guest login is public because it is where a guest whose token expired gets
  // a new one; the share registry's own passphrase check is what gates it.
  // requirementFor resolves longest-prefix-first, so the longer /api/shares
  // keeps the host API admin-only even though /api/share is public.
  shares: [
    { prefix: "/api/share/verify", requires: "public" },
    { prefix: "/api/shares", requires: "admin" },
  ],
  // "public" here is a statement of fact, not a decision: a share guest carries
  // no SessionPrincipal, so authz admits it on the guest mark rather than on a
  // role. A stricter requirement would be enforced against nobody while reading
  // like protection. What actually scopes a guest is the share branch of
  // authMiddleware plus the allowlist, and every handler in the namespace
  // re-validates the share token itself.
  "share-guest": [{ prefix: "/api/share", requires: "public" }],
  editor: admin("/api/reveal-in-folder", "/api/open-terminal", "/api/open-in-editor"),
  worktrees: [
    { prefix: "/api/worktrees", methods: ["GET"], requires: "authed" },
    { prefix: "/api/worktrees", requires: "admin" },
  ],
  usage: admin("/api/usage"),
  // The rate table is public LiteLLM data; the summary reads machine-wide
  // transcript directories, which is a host capability.
  "usage-cost": [
    ...authed("/api/usage-cost/rates"),
    ...admin("/api/usage-cost"),
  ],
  "slash-suggestions": [
    ...authed("/api/slash-suggestions"),
    ...admin("/api/expand-command"),
  ],
  // Config files and MCP definitions commonly embed bearer tokens, command
  // environment variables, and other machine credentials. Read access is a
  // secret-bearing administrative surface, not a member read-only feature.
  "config-browser": admin("/api/config-browser"),
  "local-file": admin("/api/local-file"),
  "file-content": admin("/api/file-content"),
  "project-files": admin("/api/project-files"),
  "project-file": admin("/api/project-file"),
  "git-status": admin("/api/git-status"),
  "project-icon": admin("/api/project-icon"),
  "git-diff": admin("/api/git-diff"),
  mcp: admin("/api/mcp-servers"),
  notifications: authed("/api/notifications"),
  scripts: admin("/api/scripts"),
  permissions: authed("/api/permissions"),
  "mission-control": authed("/api/mission-control"),
  "ask-user": authed("/api/user-questions", "/api/ask-user-answer"),
  models: authed("/api/models"),
  "codex-runtime": [
    ...admin("/api/codex/runtime"),
    ...authed("/api/codex/goals", "/api/codex/threads"),
  ],
  "claude-runtime": admin("/api/claude/runtime"),
  // Reading CLI versions is harmless; running the upgrade installs software on
  // the host, so that half stays an admin capability.
  "provider-updates": [
    { prefix: "/api/provider-updates", methods: ["GET"], requires: "authed" },
    { prefix: "/api/provider-updates/run", requires: "admin" },
  ],
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
    if (!prefixMatches(path, rule.prefix)) continue
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
