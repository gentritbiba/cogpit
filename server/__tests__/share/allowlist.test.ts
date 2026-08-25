// @vitest-environment node
import { describe, it, expect } from "vitest"
import { shareRequestAllowed } from "../../share/allowlist"

const SHARE = { sessionId: "sess-1", dirName: "-Users-me-proj", fileName: "sess-1.jsonl" }
const allow = (method: string, url: string) => shareRequestAllowed(method, url, SHARE)

describe("share allowlist — permitted", () => {
  it.each([
    ["GET", "/api/sessions/-Users-me-proj/sess-1.jsonl"],
    ["GET", "/api/watch/-Users-me-proj/sess-1.jsonl?offset=0"],
    ["GET", "/api/session-status/sess-1"],
    ["GET", "/api/session-file-changes/sess-1"],
    ["GET", "/api/session-config/sess-1.jsonl"],
    ["GET", "/api/share/session"],
    ["GET", "/api/share/pending"],
    ["POST", "/api/share/send-message"],
    ["POST", "/api/share/stop"],
    ["POST", "/api/share/interrupt"],
    ["POST", "/api/share/permission"],
    ["POST", "/api/share/answer"],
  ])("%s %s", (method, url) => expect(allow(method, url)).toBe(true))

  it.each([
    // the shapes the real client sends
    ["GET", "/api/sessions/-Users-me-proj/sess-1.jsonl?tail=30"],
    ["GET", "/api/sessions/-Users-me-proj/sess-1.jsonl?before=1024&count=40"],
    ["GET", "/api/session-file-changes/sess-1?since=12"],
    ["GET", "/api/session-status/sess-1?t=1"],
  ])("%s %s", (method, url) => expect(allow(method, url)).toBe(true))

  it("uppercases the method before matching", () => {
    expect(allow("get", "/api/session-status/sess-1")).toBe(true)
    expect(allow("post", "/api/share/stop")).toBe(true)
  })

  it("accepts percent-encoded identity segments, as the handlers decode them too", () => {
    expect(allow("GET", "/api/sessions/-Users-me-proj/sess-1%2Ejsonl")).toBe(true)
  })
})

describe("share allowlist — cross-session", () => {
  it.each([
    ["GET", "/api/sessions/-Users-me-proj/other.jsonl"],
    ["GET", "/api/sessions/-Users-me-other/sess-1.jsonl"],
    ["GET", "/api/watch/-Users-me-other/sess-1.jsonl"],
    ["GET", "/api/session-status/sess-2"],
    ["GET", "/api/session-file-changes/sess-2"],
    ["GET", "/api/session-config/sess-2.jsonl"],
    ["GET", "/api/session-config/-Users-me-proj"],
  ])("denies %s %s", (method, url) => expect(allow(method, url)).toBe(false))

  it("denies the project session list, which enumerates every other session", () => {
    expect(allow("GET", "/api/sessions/-Users-me-proj")).toBe(false)
    expect(allow("GET", "/api/sessions/-Users-me-proj?page=1&limit=20")).toBe(false)
  })
})

describe("share allowlist — denied surfaces", () => {
  it.each([
    ["GET", "/api/projects"],
    ["GET", "/api/active-sessions"],
    ["GET", "/api/config"],
    ["POST", "/api/config"],
    ["GET", "/api/config-browser/tree"],
    ["GET", "/api/file-content?path=/etc/passwd"],
    ["PUT", "/api/project-file"],
    ["POST", "/api/open-in-editor"],
    ["POST", "/api/reveal-in-folder"],
    ["POST", "/api/open-terminal"],
    ["GET", "/api/worktrees"],
    ["POST", "/api/send-message"],
    ["POST", "/api/stop-session"],
    ["POST", "/api/delete-session"],
    ["POST", "/api/kill-all"],
    ["GET", "/api/hub/devices"],
    ["GET", "/hub/dev_abc/api/projects"],
    ["GET", "/__pty"],
    ["GET", "/api/auth/session"],
    ["POST", "/api/auth/verify"],
    ["GET", "/api/usage"],
    ["GET", "/api/running-processes"],
  ])("denies %s %s", (method, url) => expect(allow(method, url)).toBe(false))

  it("denies /api/hello, which never reaches the guest branch", () => {
    // It is in PUBLIC_PATHS, so both middlewares answer it before the share
    // branch runs. An allowlist rule for it would be code nothing calls.
    for (const method of ["GET", "POST", "HEAD", "OPTIONS"]) {
      expect(allow(method, "/api/hello")).toBe(false)
    }
    expect(allow("GET", "/api/hello?t=1")).toBe(false)
  })

  it("denies the share endpoints it does not name", () => {
    expect(allow("POST", "/api/share/create")).toBe(false)
    expect(allow("POST", "/api/share/revoke")).toBe(false)
    expect(allow("GET", "/api/share/list")).toBe(false)
  })
})

describe("share allowlist — normalization", () => {
  it("denies a case-variant path", () => {
    expect(allow("GET", "/API/PROJECTS")).toBe(false)
  })

  it("resolves traversal before matching", () => {
    expect(allow("GET", "/api/session-status/sess-1/../../projects")).toBe(false)
  })

  it("decodes percent-encoding before matching", () => {
    expect(allow("GET", "/api/session-status/%2e%2e/%2e%2e/projects")).toBe(false)
  })

  it("matches an encoded dirName against the decoded record", () => {
    expect(allow("GET", "/api/watch/-Users-me-proj/sess-1.jsonl")).toBe(true)
  })

  it("denies a subagent file under the shared session", () => {
    // out of scope for v1: a guest gets the main transcript only
    expect(allow("GET", "/api/watch/-Users-me-proj/sess-1/subagents/agent-x.jsonl")).toBe(false)
  })

  it.each([
    // the real subagent routes hang off the shared session's own dir and file
    ["GET", "/api/sessions/-Users-me-proj/sess-1.jsonl/subagents"],
    ["GET", "/api/sessions/-Users-me-proj/sess-1.jsonl/subagents/agent-x.jsonl"],
    ["GET", "/api/watch/-Users-me-proj/sess-1.jsonl/subagents/agent-x.jsonl"],
    ["GET", "/api/session-status/sess-1/subagents"],
    ["GET", "/api/session-file-changes/sess-1/x"],
    ["GET", "/api/session-config/sess-1.jsonl/x"],
    ["PUT", "/api/session-config/sess-1.jsonl/x"],
    ["GET", "/api/hello/world"],
    ["GET", "/api/share/session/x"],
    ["GET", "/api/share/pending/x"],
    ["POST", "/api/share/send-message/x"],
  ])("denies a trailing segment on %s %s", (method, url) => expect(allow(method, url)).toBe(false))

  it("denies an unparseable url", () => {
    expect(allow("GET", "//////")).toBe(false)
  })

  it("denies every method it does not explicitly name", () => {
    expect(allow("DELETE", "/api/session-config/sess-1.jsonl")).toBe(false)
    expect(allow("POST", "/api/sessions/-Users-me-proj/sess-1.jsonl")).toBe(false)
  })
})

// ── Bypass hunting ───────────────────────────────────────────────────
//
// Express matches routes against the *raw*, undecoded, case-insensitive path
// and strips only the mount prefix, so the allowlist has to deny anything whose
// raw form could be dispatched to a route other than the one it appears to name.

describe("share allowlist — traversal that survives router prefix matching", () => {
  it.each([
    // The killer: express mounts /api/file-content and matches the raw path, so
    // resolving these dots would allow a request the router still dispatches to
    // the file reader — which ignores the path entirely and serves ?path=.
    ["GET", "/api/file-content/..%2f..%2fapi%2fhello?path=/etc/passwd"],
    ["GET", "/api/file-content/..%2f..%2fapi%2fhello"],
    ["GET", "/api/file-content/../../api/hello"],
    ["GET", "/api/config-browser/../../api/hello"],
    ["GET", "/api/projects%2f..%2f..%2fapi%2fhello"],
    ["GET", "/api/open-terminal/..%2f..%2fapi%2fsession-status%2fsess-1"],
    // dots pointing the other way, from an allowed prefix outward
    ["GET", "/api/hello/../projects"],
    ["GET", "/api/session-status/sess-1/.."],
    ["GET", "/api/session-status/./sess-1"],
    ["GET", "/api/sessions/-Users-me-proj/../-Users-me-other/sess-1.jsonl"],
    ["GET", "/api/watch/-Users-me-proj/%2e/sess-1.jsonl"],
    // double encoding — one decode leaves a literal "%2e%2e" segment, which the
    // WHATWG URL parser would then collapse as a dot segment on a second pass
    ["GET", "/api/session-status/%252e%252e/%252e%252e/projects"],
    ["GET", "/api/sessions/-Users-me-proj/sess-1.jsonl%252e"],
    ["GET", "/api/sessions/%252e/-Users-me-proj/sess-1.jsonl"],
    ["GET", "/api/session-config/%252e%252f%252e%252e/sess-1.jsonl"],
  ])("denies %s %s", (method, url) => expect(allow(method, url)).toBe(false))
})

describe("share allowlist — raw-form tricks", () => {
  it.each([
    // backslash: WHATWG URL treats it as a separator for http urls, express does not
    ["GET", "/api\\hello"],
    ["GET", "/api/hello\\..\\..\\projects"],
    ["GET", "/api/sessions/-Users-me-proj\\sess-1.jsonl"],
    ["GET", "/api/sessions/-Users-me-proj%5csess-1.jsonl"],
    // encoded separators inside an identity segment
    ["GET", "/api/sessions/-Users-me-proj%2fsess-1.jsonl"],
    ["GET", "/api/session-status/sess-1%2f..%2f..%2fapi%2fprojects"],
    // null byte and control characters
    ["GET", "/api/session-config/sess-1.jsonl%00"],
    ["GET", "/api/sessions/-Users-me-proj/sess-1.jsonl%00.png"],
    ["GET", "/api/hel\tlo"],
    ["GET", "/api/hello\n"],
    ["GET", "/api/session-status/se\tss-1"],
    // absolute and protocol-relative request targets
    ["GET", "http://evil.example/api/hello"],
    ["GET", "https://cogpit.example/api/session-status/sess-1"],
    ["GET", "//evil.example/api/hello"],
    ["GET", "//api/hello"],
    // percent-encoded prefix
    ["GET", "/%61pi/hello"],
    ["GET", "/api/%68ello"],
    // repeated and trailing slashes
    ["GET", "/api//hello"],
    ["GET", "/api/hello/"],
    ["GET", "/api/sessions//-Users-me-proj/sess-1.jsonl"],
    ["GET", "/api/sessions/-Users-me-proj//sess-1.jsonl"],
    ["GET", "/api/sessions/-Users-me-proj/sess-1.jsonl/"],
    ["GET", "/api/session-status/sess-1/"],
    ["GET", "/api/watch//"],
    ["GET", "/api/watch/"],
    ["GET", "/api/sessions/"],
    ["GET", "/api/sessions//"],
    ["GET", "/api/session-config/"],
    // malformed percent escapes
    ["GET", "/api/session-config/sess-1.jsonl%"],
    ["GET", "/api/session-config/%zz"],
    // empty and non-path targets
    ["GET", ""],
    ["GET", "*"],
    ["GET", "api/hello"],
    ["GET", "/"],
  ])("denies %s %s", (method, url) => expect(allow(method, url)).toBe(false))
})

describe("share allowlist — identity segments are compared exactly", () => {
  it.each([
    // case folding: a different share whose dirName differs only in case must
    // not be reachable, whatever the filesystem thinks
    ["GET", "/api/sessions/-users-me-proj/sess-1.jsonl"],
    ["GET", "/api/sessions/-Users-me-proj/SESS-1.JSONL"],
    ["GET", "/api/Sessions/-Users-me-proj/sess-1.jsonl"],
    ["GET", "/api/WATCH/-Users-me-proj/sess-1.jsonl"],
    ["GET", "/api/Session-Status/sess-1"],
    ["GET", "/api/HELLO"],
    ["GET", "/api/Share/session"],
    // trailing dot / trailing space: equivalent to the real name on Windows
    ["GET", "/api/sessions/-Users-me-proj./sess-1.jsonl"],
    ["GET", "/api/sessions/-Users-me-proj%20/sess-1.jsonl"],
    ["GET", "/api/session-status/sess-1."],
    ["GET", "/api/session-status/sess-1%20"],
    ["GET", "/api/session-config/sess-1.jsonl."],
    // prefix/suffix extensions of a legitimate identity
    ["GET", "/api/session-status/sess-10"],
    ["GET", "/api/session-status/xsess-1"],
    ["GET", "/api/session-config/sess-1.jsonl.json"],
    ["GET", "/api/sessions/-Users-me-proj-evil/sess-1.jsonl"],
    // "+" is not a space outside a query string
    ["GET", "/api/session-config/sess+1.jsonl"],
    // path parameters
    ["GET", "/api/hello;x=1"],
    ["GET", "/api/session-status/sess-1;/../projects"],
  ])("denies %s %s", (method, url) => expect(allow(method, url)).toBe(false))

  it("does not unicode-normalize the comparison", () => {
    const share = { sessionId: "s", dirName: "-Users-me-café", fileName: "s.jsonl" }
    const nfc = shareRequestAllowed("GET", "/api/sessions/-Users-me-caf%C3%A9/s.jsonl", share)
    const nfd = shareRequestAllowed("GET", "/api/sessions/-Users-me-cafe%CC%81/s.jsonl", share)
    expect(nfc).toBe(true)
    expect(nfd).toBe(false)
  })

  it("denies a fullwidth solidus standing in for a separator", () => {
    expect(allow("GET", "/api/sessions/-Users-me-proj／sess-1.jsonl")).toBe(false)
  })
})

describe("share allowlist — query and fragment", () => {
  it.each([
    ["GET", "/api/projects?/../api/hello"],
    ["GET", "/api/file-content#/api/hello"],
    ["GET", "/api/session-status?/sess-1"],
    ["GET", "/api/sessions?dirName=-Users-me-proj"],
    ["GET", "/api/watch?/-Users-me-proj/sess-1.jsonl"],
  ])("denies %s %s", (method, url) => expect(allow(method, url)).toBe(false))

  it("ignores a fragment on an allowed path", () => {
    expect(allow("GET", "/api/session-status/sess-1#anything")).toBe(true)
  })
})

describe("share allowlist — method scoping", () => {
  it.each([
    ["POST", "/api/session-status/sess-1"],
    ["HEAD", "/api/session-status/sess-1"],
    ["OPTIONS", "/api/session-status/sess-1"],
    ["HEAD", "/api/sessions/-Users-me-proj/sess-1.jsonl"],
    ["PUT", "/api/sessions/-Users-me-proj/sess-1.jsonl"],
    ["DELETE", "/api/sessions/-Users-me-proj/sess-1.jsonl"],
    ["POST", "/api/watch/-Users-me-proj/sess-1.jsonl"],
    ["POST", "/api/session-status/sess-1"],
    ["PUT", "/api/session-file-changes/sess-1"],
    ["POST", "/api/session-config/sess-1.jsonl"],
    ["PATCH", "/api/session-config/sess-1.jsonl"],
    // Writing session config would let a guest set the permission mode.
    ["PUT", "/api/session-config/sess-1.jsonl"],
    ["GET", "/api/share/send-message"],
    ["GET", "/api/share/stop"],
    ["POST", "/api/share/pending"],
    ["PUT", "/api/share/session"],
    ["POST", "/api/share/session"],
    ["", "/api/session-status/sess-1"],
    ["GET\n", "/api/session-status/sess-1"],
  ])("denies %s %s", (method, url) => expect(allow(method, url)).toBe(false))
})

// ── Hardening guards ─────────────────────────────────────────────────
//
// parseRequestPath rejects shapes before any identity is compared. Testing
// those rejections needs a share record whose identity the trick actually
// reproduces — against the ordinary record every one of them is denied by the
// comparison anyway, so deleting the guard would change no answer.

describe("share allowlist — hardening guards", () => {
  it("rejects an encoded separator that decodes to the share's own name", () => {
    // A nested fileName is exactly the shape a Codex rollout has.
    const nested = { sessionId: "s", dirName: "-Users-me-proj", fileName: "2026/08/25/r.jsonl" }
    expect(shareRequestAllowed(
      "GET",
      "/api/sessions/-Users-me-proj/2026%2f08%2f25%2fr.jsonl",
      nested,
    )).toBe(false)

    const backslashed = { sessionId: "s", dirName: "-Users-me-proj", fileName: "a\\b.jsonl" }
    expect(shareRequestAllowed(
      "GET",
      "/api/sessions/-Users-me-proj/a%5cb.jsonl",
      backslashed,
    )).toBe(false)

    // A surviving "%" is a separator again for anything that decodes twice.
    const percent = { sessionId: "s", dirName: "-Users-me-proj", fileName: "a%b.jsonl" }
    expect(shareRequestAllowed(
      "GET",
      "/api/sessions/-Users-me-proj/a%25b.jsonl",
      percent,
    )).toBe(false)
  })

  it("rejects a dot segment even when the share is named after one", () => {
    const dotted = { sessionId: ".", dirName: ".", fileName: ".." }
    expect(shareRequestAllowed("GET", "/api/sessions/./..", dotted)).toBe(false)
    expect(shareRequestAllowed("GET", "/api/session-status/.", dotted)).toBe(false)
    expect(shareRequestAllowed("GET", "/api/session-status/%2e", dotted)).toBe(false)
  })

  it("rejects a raw space even when the share's name contains one", () => {
    const spaced = { sessionId: "sess 1", dirName: "-Users-me-proj", fileName: "sess 1.jsonl" }
    expect(shareRequestAllowed(
      "GET",
      "/api/sessions/-Users-me-proj/sess 1.jsonl",
      spaced,
    )).toBe(false)
    expect(shareRequestAllowed("GET", "/api/session-status/sess 1", spaced)).toBe(false)
    // Encoded it is a legitimate name: the guard is about the raw target only.
    expect(shareRequestAllowed("GET", "/api/session-status/sess%201", spaced)).toBe(true)
  })
})

describe("share allowlist — degenerate share records", () => {
  it("never matches an empty identity against an empty segment", () => {
    const empty = { sessionId: "", dirName: "", fileName: "" }
    expect(shareRequestAllowed("GET", "/api/sessions//", empty)).toBe(false)
    expect(shareRequestAllowed("GET", "/api/session-status/", empty)).toBe(false)
    expect(shareRequestAllowed("GET", "/api/session-config/", empty)).toBe(false)
  })
})
