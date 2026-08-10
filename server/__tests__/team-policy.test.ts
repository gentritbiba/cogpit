// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { IncomingMessage, ServerResponse } from "node:http"

import { requirementFor } from "../team/policy"
import { teamAuthzMiddleware } from "../team/authz"
import { initEdition, __resetEditionForTest } from "../team/edition"
import { setRequestPrincipal } from "../team/requestPrincipal"
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
    expect(requirementFor("/api/config-browser/file", "GET")).toBe("authed")
    expect(requirementFor("/api/config-browser/file", "DELETE")).toBe("admin")
  })

  it("lets the longest prefix win", () => {
    // /api/config-browser and /api/config/validate both start with /api/config;
    // their own longer-prefix rules must win over the config POST admin rule.
    expect(requirementFor("/api/config-browser/tree", "GET")).toBe("authed")
    expect(requirementFor("/api/config-browser/file", "POST")).toBe("admin")
    expect(requirementFor("/api/config-browser/file", "DELETE")).toBe("admin")
    expect(requirementFor("/api/config/validate", "GET")).toBe("authed")
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

  it("marks host-app launching, hub devices, and usage admin", () => {
    expect(requirementFor("/api/reveal-in-folder", "POST")).toBe("admin")
    expect(requirementFor("/api/open-terminal", "POST")).toBe("admin")
    expect(requirementFor("/api/open-in-editor", "POST")).toBe("admin")
    expect(requirementFor("/api/hub/devices", "GET")).toBe("admin")
    expect(requirementFor("/api/usage", "GET")).toBe("admin")
  })

  it("keeps the everyday session surfaces authed", () => {
    expect(requirementFor("/api/projects", "GET")).toBe("authed")
    expect(requirementFor("/api/sessions/dir/file.jsonl", "GET")).toBe("authed")
    expect(requirementFor("/api/send-message", "POST")).toBe("authed")
    expect(requirementFor("/api/new-session", "POST")).toBe("authed")
    expect(requirementFor("/api/notify", "POST")).toBe("authed")
    expect(requirementFor("/api/undo/apply", "POST")).toBe("authed")
    expect(requirementFor("/hub/", "GET")).toBe("authed")
    expect(requirementFor("/hub/device-1/api/projects", "GET")).toBe("authed")
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

function run(url: string, opts: { method?: string; principal?: SessionPrincipal } = {}) {
  const req = {
    url,
    method: opts.method ?? "GET",
    headers: {},
  } as unknown as IncomingMessage
  if (opts.principal) setRequestPrincipal(req, opts.principal)
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
    // Trusted-local /api/notify and first-run /api/team/bootstrap arrive
    // without a principal; authz must not lock them out.
    expect(run("/api/notify", { method: "POST" }).next).toHaveBeenCalledOnce()
    expect(run("/api/team/bootstrap", { method: "POST" }).next).toHaveBeenCalledOnce()
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

describe("teamAuthzMiddleware (personal edition)", () => {
  it("no-ops even for garbage paths without a principal", () => {
    expect(run("/api/never-registered").next).toHaveBeenCalledOnce()
    expect(run("/api/kill-all", { method: "POST" }).next).toHaveBeenCalledOnce()
    expect(run("/api/config", { method: "POST" }).next).toHaveBeenCalledOnce()
  })
})
