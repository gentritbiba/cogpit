// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { IncomingMessage, ServerResponse } from "node:http"

import { requirementFor } from "../team/policy"
import { teamAuthzMiddleware } from "../team/authz"
import { initEdition, __resetEditionForTest } from "../team/edition"
import { setRequestPrincipal } from "../team/requestPrincipal"
import { markShareGuestRequest } from "../share/requestGuest"
import type { SessionPrincipal } from "../team/constants"

const ADMIN: SessionPrincipal = { userId: "u-admin", username: "alice", role: "admin" }
const MEMBER: SessionPrincipal = { userId: "u-member", username: "bob", role: "member" }

const originalEditionEnv = process.env.COGPIT_EDITION

function enterTeamEdition(): void {
  initEdition({ shell: "standalone", configEdition: "team" })
}

beforeEach(() => {
  delete process.env.COGPIT_EDITION
})

afterEach(() => {
  __resetEditionForTest()
  if (originalEditionEnv === undefined) delete process.env.COGPIT_EDITION
  else process.env.COGPIT_EDITION = originalEditionEnv
})

// ── requirementFor: matching semantics ──────────────────────────────────

describe("requirementFor", () => {
  it("keeps /api/hello public", () => {
    expect(requirementFor("/api/hello", "GET")).toBe("public")
  })

  it("answers admin for unmatched paths (fail-safe default)", () => {
    expect(requirementFor("/api/never-registered", "GET")).toBe("admin")
  })

  it("keeps the login endpoint public, as PUBLIC_PATHS already makes it", () => {
    // A team user's first request has no principal by construction. Listing it
    // as "authed" only worked while authz waved every principal-less request
    // through, which is exactly what stopped being true.
    expect(requirementFor("/api/auth/verify", "POST")).toBe("public")
  })

  it("lets a method-specific rule beat a method-agnostic one at equal prefix", () => {
    expect(requirementFor("/api/config", "POST")).toBe("admin")
    expect(requirementFor("/api/config", "GET")).toBe("authed")
  })

  it("treats unknown /api/config methods as admin (conservative default)", () => {
    expect(requirementFor("/api/config", "DELETE")).toBe("admin")
    expect(requirementFor("/api/config", "PUT")).toBe("admin")
    expect(requirementFor("/api/auth/logout", "POST")).toBe("authed")
  })

  it("only matches prefixes at path-segment boundaries", () => {
    // Bare startsWith would let /api/hellox ride the /api/hello public rule.
    expect(requirementFor("/api/hellox", "GET")).toBe("admin")
    expect(requirementFor("/api/hello", "GET")).toBe("public")
    expect(requirementFor("/api/config-browserx", "GET")).toBe("admin")
    expect(requirementFor("/api/config-browser/file", "GET")).toBe("admin")
    expect(requirementFor("/api/config-browser/file", "DELETE")).toBe("admin")
  })

  it("lets the longest prefix win", () => {
    // /api/config-browser and /api/config/validate both start with /api/config;
    // their own longer-prefix rules must win over the config POST admin rule.
    expect(requirementFor("/api/config-browser/tree", "GET")).toBe("admin")
    expect(requirementFor("/api/config-browser/file", "POST")).toBe("admin")
    expect(requirementFor("/api/config-browser/file", "DELETE")).toBe("admin")
    expect(requirementFor("/api/config/validate", "GET")).toBe("admin")
  })

  it("marks the kill surfaces admin", () => {
    expect(requirementFor("/api/kill-all", "POST")).toBe("admin")
    expect(requirementFor("/api/kill-process", "POST")).toBe("admin")
    expect(requirementFor("/api/kill-port", "POST")).toBe("admin")
    expect(requirementFor("/api/system-processes", "GET")).toBe("admin")
    expect(requirementFor("/api/system-processes/kill", "POST")).toBe("admin")
  })

  it("keeps per-session and background surfaces authed", () => {
    expect(requirementFor("/api/stop-session", "POST")).toBe("authed")
    expect(requirementFor("/api/interrupt-session", "POST")).toBe("authed")
    expect(requirementFor("/api/delete-session", "POST")).toBe("authed")
    expect(requirementFor("/api/check-ports", "GET")).toBe("authed")
    expect(requirementFor("/api/background-tasks", "GET")).toBe("authed")
    expect(requirementFor("/api/background-agents", "GET")).toBe("authed")
  })

  it("keeps hub device discovery readable but mutations admin-only", () => {
    expect(requirementFor("/api/reveal-in-folder", "POST")).toBe("admin")
    expect(requirementFor("/api/open-terminal", "POST")).toBe("admin")
    expect(requirementFor("/api/open-in-editor", "POST")).toBe("admin")
    expect(requirementFor("/api/hub/devices", "GET")).toBe("authed")
    expect(requirementFor("/api/hub/devices", "POST")).toBe("admin")
    expect(requirementFor("/api/hub/devices/device-1", "PATCH")).toBe("admin")
    expect(requirementFor("/api/hub/devices/device-1", "DELETE")).toBe("admin")
    expect(requirementFor("/api/usage", "GET")).toBe("admin")
    expect(requirementFor("/api/codex/runtime", "GET")).toBe("admin")
    expect(requirementFor("/api/claude/runtime", "GET")).toBe("admin")
    expect(requirementFor("/api/codex/goals", "GET")).toBe("authed")
    expect(requirementFor("/api/codex/threads", "GET")).toBe("authed")
  })

  it("keeps the everyday session surfaces authed", () => {
    expect(requirementFor("/api/projects", "GET")).toBe("authed")
    expect(requirementFor("/api/sessions/dir/file.jsonl", "GET")).toBe("authed")
    expect(requirementFor("/api/send-message", "POST")).toBe("authed")
    expect(requirementFor("/api/new-session", "POST")).toBe("authed")
    expect(requirementFor("/api/notifications", "GET")).toBe("authed")
    expect(requirementFor("/api/notifications/read", "POST")).toBe("authed")
    expect(requirementFor("/api/usage-cost/session", "GET")).toBe("authed")
    expect(requirementFor("/api/usage-cost/session/extra", "GET")).toBe("authed")
    expect(requirementFor("/api/usage-cost", "GET")).toBe("admin")
    expect(requirementFor("/api/undo-state/session-1", "GET")).toBe("admin")
    expect(requirementFor("/hub/", "GET")).toBe("authed")
    expect(requirementFor("/hub/device-1/api/projects", "GET")).toBe("authed")
  })

  it("keeps caller-selected host filesystem surfaces admin-only", () => {
    expect(requirementFor("/api/undo/transaction", "POST")).toBe("admin")
    expect(requirementFor("/api/project-file", "GET")).toBe("admin")
    expect(requirementFor("/api/project-file", "PUT")).toBe("admin")
    expect(requirementFor("/api/file-content", "GET")).toBe("admin")
    expect(requirementFor("/api/local-file", "GET")).toBe("admin")
    expect(requirementFor("/api/project-files", "GET")).toBe("admin")
    expect(requirementFor("/api/check-files-exist", "POST")).toBe("admin")
    expect(requirementFor("/api/scripts", "GET")).toBe("admin")
    expect(requirementFor("/api/git-status", "GET")).toBe("admin")
    expect(requirementFor("/api/session-file-changes/session-1", "GET")).toBe("admin")
  })

  it("keeps secret-bearing config and host mutations admin-only", () => {
    expect(requirementFor("/api/config-browser/tree", "GET")).toBe("admin")
    expect(requirementFor("/api/config-browser/file", "GET")).toBe("admin")
    expect(requirementFor("/api/mcp-servers", "GET")).toBe("admin")
    expect(requirementFor("/api/config/validate", "GET")).toBe("admin")
    expect(requirementFor("/api/expand-command", "POST")).toBe("admin")
    expect(requirementFor("/api/claude/checkpoints/session/rewind", "POST")).toBe("admin")
  })

  it("keeps worktree listing authed but mutations admin-only", () => {
    expect(requirementFor("/api/worktrees/project", "GET")).toBe("authed")
    expect(requirementFor("/api/worktrees/project/feature", "DELETE")).toBe("admin")
    expect(requirementFor("/api/worktrees/project/create-pr", "POST")).toBe("admin")
    expect(requirementFor("/api/worktrees/project/cleanup", "POST")).toBe("admin")
  })
})

// ── teamAuthzMiddleware ─────────────────────────────────────────────────

function mockRes(): { res: ServerResponse; body: string; statusCode: number } {
  let body = ""
  let statusCode = 200
  const res = {
    get statusCode() { return statusCode },
    set statusCode(v: number) { statusCode = v },
    setHeader: vi.fn(),
    end: (data?: string) => { body = data || "" },
  } as unknown as ServerResponse
  return { res, get body() { return body }, get statusCode() { return statusCode } }
}

function run(
  url: string,
  opts: { method?: string; principal?: SessionPrincipal; shareGuest?: true } = {},
) {
  const req = {
    url,
    method: opts.method ?? "GET",
    headers: {},
  } as unknown as IncomingMessage
  if (opts.principal) setRequestPrincipal(req, opts.principal)
  if (opts.shareGuest) markShareGuestRequest(req)
  const mock = mockRes()
  const next = vi.fn()
  teamAuthzMiddleware(req, mock.res, next)
  return { next, get statusCode() { return mock.statusCode }, get body() { return mock.body } }
}

describe("teamAuthzMiddleware (team edition)", () => {
  beforeEach(enterTeamEdition)

  it("lets a member through an authed surface", () => {
    const r = run("/api/projects", { principal: MEMBER })
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("rejects a member POST /api/config with 403", () => {
    const r = run("/api/config", { method: "POST", principal: MEMBER })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(403)
    expect(JSON.parse(r.body)).toEqual({ error: "Admin access required", code: "FORBIDDEN" })
  })

  it("lets an admin POST /api/config", () => {
    const r = run("/api/config", { method: "POST", principal: ADMIN })
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("lets a member GET /api/config", () => {
    const r = run("/api/config", { principal: MEMBER })
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("lets a member list hub devices but blocks device mutations", () => {
    expect(run("/api/hub/devices", { principal: MEMBER }).next).toHaveBeenCalledOnce()
    const mutation = run("/api/hub/devices", { method: "POST", principal: MEMBER })
    expect(mutation.next).not.toHaveBeenCalled()
    expect(mutation.statusCode).toBe(403)
  })

  it("blocks members from caller-selected host file APIs", () => {
    for (const [url, method] of [
      ["/api/undo/transaction", "POST"],
      ["/api/project-file", "PUT"],
      ["/api/file-content", "GET"],
      ["/api/session-file-changes/session-1?content=true", "GET"],
    ] as const) {
      const r = run(url, { method, principal: MEMBER })
      expect(r.next).not.toHaveBeenCalled()
      expect(r.statusCode).toBe(403)
    }
  })

  it("blocks provider account/runtime usage for members but keeps Codex session metadata", () => {
    for (const url of ["/api/usage", "/api/codex/runtime", "/api/claude/runtime"]) {
      const r = run(url, { principal: MEMBER })
      expect(r.next, url).not.toHaveBeenCalled()
      expect(r.statusCode, url).toBe(403)
    }
    expect(run("/api/codex/goals", { principal: MEMBER }).next).toHaveBeenCalledOnce()
    expect(run("/api/codex/threads", { principal: MEMBER }).next).toHaveBeenCalledOnce()
  })

  it("blocks members from reading secret-bearing configuration", () => {
    for (const [url, method] of [
      ["/api/config-browser/tree", "GET"],
      ["/api/config-browser/file?path=/home/cogpit/.claude/settings.json", "GET"],
      ["/api/mcp-servers?cwd=/srv/project", "GET"],
      ["/api/config/validate?path=/home/cogpit/.claude", "GET"],
      ["/api/expand-command", "POST"],
      ["/api/claude/checkpoints/session/rewind", "POST"],
    ] as const) {
      const r = run(url, { method, principal: MEMBER })
      expect(r.next, `${method} ${url}`).not.toHaveBeenCalled()
      expect(r.statusCode, `${method} ${url}`).toBe(403)
    }
  })

  it("allows member worktree listing but blocks mutations", () => {
    expect(run("/api/worktrees/project", { principal: MEMBER }).next).toHaveBeenCalledOnce()
    for (const [url, method] of [
      ["/api/worktrees/project/feature", "DELETE"],
      ["/api/worktrees/project/create-pr", "POST"],
      ["/api/worktrees/project/cleanup", "POST"],
    ] as const) {
      const r = run(url, { method, principal: MEMBER })
      expect(r.next).not.toHaveBeenCalled()
      expect(r.statusCode).toBe(403)
    }
  })

  it("keeps member logout reachable", () => {
    const r = run("/api/auth/logout", { method: "POST", principal: MEMBER })
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("rejects a member /api/kill-all with 403", () => {
    const r = run("/api/kill-all", { method: "POST", principal: MEMBER })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(403)
  })

  it("lets a member /api/stop-session through", () => {
    const r = run("/api/stop-session", { method: "POST", principal: MEMBER })
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("treats unregistered API paths as admin-only", () => {
    const member = run("/api/never-registered", { principal: MEMBER })
    expect(member.next).not.toHaveBeenCalled()
    expect(member.statusCode).toBe(403)

    const admin = run("/api/never-registered", { principal: ADMIN })
    expect(admin.next).toHaveBeenCalledOnce()
  })

  it("lets public paths through without any principal", () => {
    const r = run("/api/hello")
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("trusts authMiddleware carve-outs that attach no principal", () => {
    // First-run /api/team/bootstrap arrives without a principal; authz must
    // not lock it out.
    expect(run("/api/team/bootstrap", { method: "POST" }).next).toHaveBeenCalledOnce()
    // As does the login endpoint, where a user has no principal yet.
    expect(run("/api/auth/verify", { method: "POST" }).next).toHaveBeenCalledOnce()
  })

  it("admits a share guest, whose scope is the share allowlist", () => {
    // A guest holds no SessionPrincipal and never will: the share branch of
    // authMiddleware plus the allowlist decided what it may reach, and that is
    // a far narrower list than any rule in this table. It is admitted because
    // it was marked, not because nothing marked it.
    for (const url of [
      "/api/session-status/sess-1",
      "/api/watch/-Users-me-proj/sess-1.jsonl",
      "/api/share/send-message",
    ]) {
      expect(run(url, { shareGuest: true }).next, url).toHaveBeenCalledOnce()
    }
  })

  it("locks out a principal-less request that is neither public nor a guest", () => {
    // The fail-closed half of the pair above. authMiddleware admits exactly
    // three kinds of principal-less request — public paths, first-run
    // bootstrap, and a marked share guest — so anything else arriving here is
    // a hole in it, and must not be waved through on the way past.
    for (const [url, method] of [
      ["/api/projects", "GET"],
      ["/api/session-status/sess-1", "GET"],
      ["/api/kill-all", "POST"],
      ["/api/never-registered", "GET"],
    ] as const) {
      const r = run(url, { method })
      expect(r.next, url).not.toHaveBeenCalled()
      expect(r.statusCode, url).toBe(403)
    }
  })

  it("matches on the query-stripped, lowercased path", () => {
    const r = run("/API/Config?source=ui", { method: "POST", principal: MEMBER })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(403)
  })

  it("ignores non-API, non-hub paths", () => {
    const r = run("/index.html", { principal: MEMBER })
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("keeps members out of admin surfaces behind the hub prefix gate", () => {
    const r = run("/api/system-processes", { principal: MEMBER })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(403)
  })

  it("lets a member reach proxied hub devices", () => {
    const r = run("/hub/device-1/api/projects", { principal: MEMBER })
    expect(r.next).toHaveBeenCalledOnce()
  })
})

describe("teamAuthzMiddleware non-origin-form targets (team edition)", () => {
  beforeEach(enterTeamEdition)

  // The prefix test that decides whether a request is policed at all ran
  // against the raw request target, so an absolute-form target skipped the
  // whole role table: a member could reach every admin-only route by asking
  // for it as `GET http://host/api/team/users HTTP/1.1`.

  it("polices an absolute-form target against the role table", () => {
    const r = run("http://cogpit.local:19384/api/team/users", { principal: MEMBER })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(403)
  })

  it("polices an absolute-form hub target", () => {
    // /hub/ itself is "authed"; the downstream path is the hub proxy's own
    // check. What matters here is that the request is policed at all rather
    // than skipping the table because its target did not start with "/hub/".
    const anonymous = run("http://cogpit.local:19384/hub/dev_1/api/projects")
    expect(anonymous.next).not.toHaveBeenCalled()
    expect(anonymous.statusCode).toBe(403)
    expect(run("http://cogpit.local:19384/hub/dev_1/api/projects", { principal: MEMBER }).next)
      .toHaveBeenCalledOnce()
  })

  it("still admits an absolute-form target the member is allowed to reach", () => {
    expect(run("http://cogpit.local:19384/api/projects", { principal: MEMBER }).next)
      .toHaveBeenCalledOnce()
    expect(run("http://cogpit.local:19384/index.html", { principal: MEMBER }).next)
      .toHaveBeenCalledOnce()
  })

  it("fails closed on a target it cannot reduce to a path", () => {
    for (const url of ["//evil.example/api/team/users", "*", "http://[::1"]) {
      const r = run(url, { principal: MEMBER })
      expect(r.next).not.toHaveBeenCalled()
      expect(r.statusCode).toBe(403)
    }
  })
})

describe("teamAuthzMiddleware (personal edition)", () => {
  it("no-ops even for garbage paths without a principal", () => {
    expect(run("/api/never-registered").next).toHaveBeenCalledOnce()
    expect(run("/api/kill-all", { method: "POST" }).next).toHaveBeenCalledOnce()
    expect(run("/api/config", { method: "POST" }).next).toHaveBeenCalledOnce()
  })
})
