# Session Sharing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let a guest join exactly one Cogpit session over the existing network/tunnel access, authenticated by a per-session generated passphrase, without reaching any other part of the app.

**Architecture:** A file-backed share registry (`shares.local.json`) holds one record per shared session. A guest logs in at `POST /api/share/verify` and receives a share token in a `__Host-cogpit_share` cookie. `authMiddleware` grows a share branch that default-denies every route except a small allowlist. URL-keyed reads keep their real paths (verified against the record), while mutations move to `/api/share/*` endpoints where the sessionId comes from the token and cannot be spoofed. The frontend branches at the root of `main.tsx` into a separate `SharedRoot` tree.

**Tech Stack:** TypeScript, Node HTTP (Connect-style `UseFn` mounting, no Express Router), React 19, Vitest, bun.

**Companion documents:**
- `docs/plans/2026-08-25-session-sharing-design.md` — the approved design and its rationale
- `docs/plans/2026-08-25-session-sharing-code-reference.md` — verbatim current signatures for every module touched here. **Read the relevant section before each task.** Section numbers are cited per task as `[ref §N]`.

**Working directory:** `.worktrees/session-sharing`, branch `session-sharing`.

**Baseline:** 4058 tests pass. `server/__tests__/sdk-session.test.ts > appends captured CLI stderr` is flaky under full-suite load and passes in isolation — it is not your regression.

---

## Ground rules

- **TDD, strictly.** Write the failing test, run it, watch it fail for the right reason, then implement. A test that passes before you write the code is testing nothing.
- **Commit after every task.** The commit message is given per task.
- **Never add Claude as co-author.** No `Co-Authored-By` lines.
- **Run `bun run test` before each commit.** Also `bun run lint` and `bun run typecheck` before the commits at the end of each phase.
- **Delete what you replace.** No dead code, no commented-out old versions.
- Test files: `server/__tests__/**/*.test.ts` need `// @vitest-environment node` on line 1. Follow the mocking idiom in `[ref §17]` exactly — `vi.hoisted` for mock fns, `vi.mock` of `../../helpers`, `buildHandler()` collecting `use()` calls into a Map.

---

# Phase 1 — Share registry

No HTTP yet. Pure data layer, fully testable.

## Task 1: Passphrase generator

**Files:**
- Create: `server/share/passphrase.ts`
- Test: `server/__tests__/share/passphrase.test.ts`

**Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest"
import { generatePassphrase, PASSPHRASE_WORDS } from "../../share/passphrase"
import { MIN_PASSWORD_LENGTH } from "../../password-utils"

describe("generatePassphrase", () => {
  it("produces four dash-separated words and a two-digit suffix", () => {
    expect(generatePassphrase()).toMatch(/^[a-z]+-[a-z]+-[a-z]+-[a-z]+-\d{2}$/)
  })

  it("always clears the password-strength minimum", () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePassphrase().length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH)
    }
  })

  it("does not repeat within a reasonable sample", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generatePassphrase()))
    expect(seen.size).toBe(500)
  })

  it("draws from a wordlist large enough to be worth guessing", () => {
    // 4 words from N plus 100 suffixes; need >= 2^50 to be brute-force-hostile
    expect(PASSPHRASE_WORDS.length ** 4 * 100).toBeGreaterThan(2 ** 50)
  })

  it("uses only lowercase ascii words with no duplicates in the list", () => {
    expect(new Set(PASSPHRASE_WORDS).size).toBe(PASSPHRASE_WORDS.length)
    for (const word of PASSPHRASE_WORDS) expect(word).toMatch(/^[a-z]{3,8}$/)
  })
})
```

**Step 2: Run it and watch it fail**

`bunx vitest run server/__tests__/share/passphrase.test.ts`
Expected: FAIL — cannot resolve `../../share/passphrase`.

**Step 3: Implement**

```ts
import { randomInt } from "node:crypto"

/**
 * Short, unambiguous, keyboard-simple words. Homophones and letter-shape
 * collisions are excluded because a share passphrase is routinely read aloud
 * over a call.
 */
export const PASSPHRASE_WORDS = [
  // Fill to at least 512 entries. 512^4 * 100 ≈ 2^58.
] as const

export function generatePassphrase(): string {
  const words = Array.from(
    { length: 4 },
    () => PASSPHRASE_WORDS[randomInt(PASSPHRASE_WORDS.length)],
  )
  return `${words.join("-")}-${String(randomInt(100)).padStart(2, "0")}`
}
```

Populate `PASSPHRASE_WORDS` with **at least 512** distinct 3-8 letter lowercase words. Use `randomInt` from `node:crypto`, never `Math.random`. The four-word minimum plus the wordlist floor is what the fourth test pins; if you shrink the list the test fails, which is the point.

**Step 4: Run and verify green**

`bunx vitest run server/__tests__/share/passphrase.test.ts`
Expected: 5 passed.

**Step 5: Commit**

```bash
git add server/share/passphrase.ts server/__tests__/share/passphrase.test.ts
git commit -m "feat(share): generate speakable share passphrases"
```

---

## Task 2: Share registry

**Files:**
- Create: `server/share/registry.ts`
- Test: `server/__tests__/share/registry.test.ts`

Read `[ref §2]` first. This module clones `server/hub/registry.ts` structurally: module-level `registryPath`, an in-memory `Map`, a serialized operation queue, and `commitShareMutation` that persists *before* mutating live state so a failed write rolls back by discarding the draft. Do not invent a different concurrency approach.

**Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  initShareRegistry,
  createShare,
  getShare,
  listShares,
  removeShare,
  rotateSharePassword,
} from "../../share/registry"
import { verifyPassword } from "../../password-utils"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cogpit-shares-"))
  await initShareRegistry(dir)
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const INPUT = { sessionId: "sess-1", dirName: "-Users-me-proj", fileName: "sess-1.jsonl" }

describe("share registry", () => {
  it("returns the plaintext passphrase exactly once, at creation", async () => {
    const created = await createShare(INPUT)
    expect(created.passphrase).toMatch(/-\d{2}$/)
    const stored = getShare("sess-1")
    expect(stored).toBeDefined()
    expect(stored).not.toHaveProperty("passphrase")
    expect(verifyPassword(created.passphrase, stored!.passwordHash)).toBe(true)
  })

  it("never persists the plaintext passphrase", async () => {
    const created = await createShare(INPUT)
    const raw = await readFile(join(dir, "shares.local.json"), "utf-8")
    expect(raw).not.toContain(created.passphrase)
  })

  it("writes the file owner-only", async () => {
    await createShare(INPUT)
    const info = await stat(join(dir, "shares.local.json"))
    expect(info.mode & 0o777).toBe(0o600)
  })

  it("reloads shares from disk", async () => {
    const created = await createShare(INPUT)
    await initShareRegistry(dir)
    expect(verifyPassword(created.passphrase, getShare("sess-1")!.passwordHash)).toBe(true)
  })

  it("re-sharing an already shared session replaces the passphrase", async () => {
    const first = await createShare(INPUT)
    const second = await createShare(INPUT)
    expect(second.passphrase).not.toBe(first.passphrase)
    expect(listShares()).toHaveLength(1)
    expect(verifyPassword(first.passphrase, getShare("sess-1")!.passwordHash)).toBe(false)
  })

  it("rotates the passphrase in place", async () => {
    const first = await createShare(INPUT)
    const rotated = await rotateSharePassword("sess-1")
    expect(rotated).not.toBeNull()
    expect(verifyPassword(first.passphrase, getShare("sess-1")!.passwordHash)).toBe(false)
    expect(verifyPassword(rotated!.passphrase, getShare("sess-1")!.passwordHash)).toBe(true)
  })

  it("rotating an unknown share returns null", async () => {
    expect(await rotateSharePassword("nope")).toBeNull()
  })

  it("removes shares", async () => {
    await createShare(INPUT)
    expect(await removeShare("sess-1")).toBe(true)
    expect(getShare("sess-1")).toBeUndefined()
    expect(await removeShare("sess-1")).toBe(false)
  })

  it("listShares never exposes the hash", async () => {
    await createShare(INPUT)
    expect(listShares()[0]).not.toHaveProperty("passwordHash")
  })

  it("starts empty on corrupt JSON instead of throwing", async () => {
    await createShare(INPUT)
    const { writeFile } = await import("node:fs/promises")
    await writeFile(join(dir, "shares.local.json"), "{not json")
    await initShareRegistry(dir)
    expect(listShares()).toHaveLength(0)
  })

  it("serializes concurrent creates without losing records", async () => {
    await Promise.all([
      createShare({ ...INPUT, sessionId: "a" }),
      createShare({ ...INPUT, sessionId: "b" }),
      createShare({ ...INPUT, sessionId: "c" }),
    ])
    expect(listShares().map((s) => s.sessionId).sort()).toEqual(["a", "b", "c"])
  })
})
```

**Step 2: Run and watch it fail**

`bunx vitest run server/__tests__/share/registry.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement**

```ts
import { readFile, chmod } from "node:fs/promises"
import { join } from "node:path"
import { writeOwnerOnlyJson } from "../atomicJsonFile"
import { hashPassword } from "../password-utils"
import { generatePassphrase } from "./passphrase"

/**
 * Per-session share registry.
 *
 * Persists one record per shared session to `shares.local.json` beside
 * `config.local.json`. The file holds a scrypt hash of a passphrase that grants
 * full participation in one session, so it is written 0600 and re-chmodded
 * after every write (writeFile's mode only applies at creation).
 *
 * The plaintext passphrase exists only in the return value of createShare and
 * rotateSharePassword. It is never stored, never logged, and never returned by
 * a read.
 */

export interface ShareRecord {
  sessionId: string
  dirName: string
  fileName: string
  /** scrypt hash from password-utils */
  passwordHash: string
  createdAt: number
  lastAccessAt: number
}

/** Safe to send to the host UI — no hash, no passphrase. */
export type PublicShare = Omit<ShareRecord, "passwordHash">

export interface CreateShareInput {
  sessionId: string
  dirName: string
  fileName: string
}
```

Then, mirroring `[ref §2]` exactly:

- `let registryPath: string | null = null`, `const shares = new Map<string, ShareRecord>()`, `let queue: Promise<void> = Promise.resolve()`
- `enqueue<T>(op)` — copy `enqueueRegistryOperation` verbatim, renamed
- `normalizeShare(entry: unknown): ShareRecord | null` — reject anything missing a string `sessionId`, `dirName`, `fileName`, `passwordHash`; coerce `createdAt`/`lastAccessAt` to `0` when absent
- `commitShareMutation<T>(mutate)` — copy `commitDeviceMutation` verbatim, renamed: clone the map *and* each record, run the mutation on the draft, persist the snapshot, then `replaceShares(draft)`
- `initShareRegistry(dir)` — copy `initDeviceRegistry`: `join(dir, "shares.local.json")`, `readFile` then `chmod(path, 0o600)`, missing or corrupt → empty
- `createShare(input)` → `Promise<{ share: PublicShare; passphrase: string }>` — generate, hash, `draft.set(sessionId, record)` (overwriting any existing record for that session), return `{ share: toPublic(record), passphrase }`
- `rotateSharePassword(sessionId)` → same return type or `null` when absent
- `getShare(sessionId): ShareRecord | undefined` — internal, full record
- `listShares(): PublicShare[]` — destructure `passwordHash` out explicitly, exactly as `listDevices` does with `password`
- `removeShare(sessionId): Promise<boolean>`
- `touchShare(sessionId): void` — update `lastAccessAt` in memory only; do not persist on every guest request

**Step 4: Run and verify green**

`bunx vitest run server/__tests__/share/registry.test.ts`
Expected: 11 passed.

**Step 5: Commit**

```bash
git add server/share/registry.ts server/__tests__/share/registry.test.ts
git commit -m "feat(share): persist per-session share records"
```

---

## Task 3: Initialize the registry in every shell

**Files:**
- Modify: `server/app-server.ts:78` (beside `await initDeviceRegistry(userDataDir)`)
- Modify: `server/api-plugin.ts:31` (beside `initDeviceRegistry(...)`)
- Test: `server/__tests__/share/registry-init.test.ts`

Both shells must initialize the share registry or a share created in dev vanishes in Electron. `[ref §2]` lists both call sites.

**Step 1: Write the failing test** — assert that `server/app-server.ts` and `server/api-plugin.ts` each contain an `initShareRegistry` call adjacent to the device registry one. A grep-style source assertion is the honest test here; the alternative is booting two full shells.

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const read = (rel: string) =>
  readFile(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf-8")

describe("share registry initialization parity", () => {
  it.each(["app-server.ts", "api-plugin.ts"])(
    "%s initializes the share registry wherever it initializes the device registry",
    async (file) => {
      const source = await read(file)
      expect(source).toContain("initDeviceRegistry")
      expect(source).toContain("initShareRegistry")
    },
  )
})
```

**Step 2: Run and watch it fail.** Expected: both cases fail on the `initShareRegistry` assertion.

**Step 3: Implement.** Add the import and the call in both files, using the same await/non-await style each file already uses for `initDeviceRegistry`.

**Step 4: Run and verify green.**

**Step 5: Commit**

```bash
git add server/app-server.ts server/api-plugin.ts server/__tests__/share/registry-init.test.ts
git commit -m "feat(share): load the share registry in every server shell"
```

---

# Phase 2 — Share tokens and the auth branch

The security core. Do not rush this phase; every task here has a test that exists specifically to catch a privilege escalation.

## Task 4: Hoist the scrypt concurrency limiter

**Files:**
- Create: `server/password-verify.ts`
- Modify: `server/routes/config.ts:29-54` — delete `verifyRemotePassword`, `MAX_CONCURRENT_PASSWORD_VERIFICATIONS`, `activePasswordVerifications`, `dummyHash`, `getDummyHash`; import them instead
- Test: `server/__tests__/password-verify.test.ts`

Pure refactor. `[ref §3]` shows both functions verbatim — they are currently module-private in the config route, and the share login path needs the same limiter and the same timing pad. Duplicating them would mean two independent concurrency budgets, which defeats the limiter.

**Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest"
import { verifyRemotePassword, getDummyHash } from "../password-verify"
import { hashPassword } from "../password-utils"

describe("verifyRemotePassword", () => {
  it("accepts the right password", async () => {
    expect(await verifyRemotePassword("correct horse battery", hashPassword("correct horse battery"))).toBe("valid")
  })

  it("rejects the wrong one", async () => {
    expect(await verifyRemotePassword("nope", hashPassword("correct horse battery"))).toBe("invalid")
  })

  it("reports busy past the concurrency ceiling", async () => {
    const stored = hashPassword("correct horse battery")
    const results = await Promise.all(
      Array.from({ length: 8 }, () => verifyRemotePassword("correct horse battery", stored)),
    )
    expect(results).toContain("busy")
    expect(results.filter((r) => r !== "busy").every((r) => r === "valid")).toBe(true)
  })

  it("returns a stable dummy hash for timing padding", () => {
    expect(getDummyHash()).toBe(getDummyHash())
    expect(getDummyHash().startsWith("$scrypt$")).toBe(true)
  })
})
```

**Step 2: Run and watch it fail.** Expected: module not found.

**Step 3: Implement.** Move the two blocks from `[ref §3]` into `server/password-verify.ts` verbatim, exporting `verifyRemotePassword` and `getDummyHash`. Then delete them from `server/routes/config.ts` and import from the new module. Note that `config.ts` currently imports password helpers **through `../helpers`** — keep that convention if `helpers` re-exports, otherwise import the new module directly.

**Step 4: Run and verify green**

`bun run test` — the whole suite. `server/__tests__/routes/config-routes.test.ts` and `team-login.test.ts` must still pass unchanged. If either needed editing, you changed behavior; revert and try again.

**Step 5: Commit**

```bash
git add server/password-verify.ts server/routes/config.ts server/__tests__/password-verify.test.ts
git commit -m "refactor: hoist the scrypt verification limiter out of the config route"
```

---

## Task 5: Share token store

**Files:**
- Modify: `server/security.ts` — new section after the existing session token system
- Test: `server/__tests__/share/tokens.test.ts`

Share tokens live in `security.ts` and **not** in a separate module, because the auth branch needs `cookieValue`, `bearerToken`, `SAFE_METHODS`, and `isUnforwardedUntrustedLoopback`, all of which are module-private (`[ref §4]`). Keep them in their own clearly-marked section with a separate map — do **not** reuse `activeSessions`, whose `principal` is team-edition-shaped and gets persisted to the team session store.

**Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  createShareToken,
  validateShareToken,
  revokeShareToken,
  revokeShareTokensForSession,
  revokeAllShareTokens,
  countShareGuests,
  setShareCookie,
  clearShareCookie,
  getRequestShareToken,
  __resetShareTokensForTest,
} from "../../security"

beforeEach(() => { __resetShareTokensForTest() })

describe("share tokens", () => {
  it("round-trips the session it was minted for", () => {
    const token = createShareToken("sess-1", "1.2.3.4", "UA/1")
    expect(validateShareToken(token, "UA/1")).toBe("sess-1")
  })

  it("returns null for an unknown token", () => {
    expect(validateShareToken("deadbeef", "UA/1")).toBeNull()
  })

  it("pins the user agent", () => {
    const token = createShareToken("sess-1", "1.2.3.4", "UA/1")
    expect(validateShareToken(token, "UA/2")).toBeNull()
    // a rejected mismatch also discards the token
    expect(validateShareToken(token, "UA/1")).toBeNull()
  })

  it("revokes every token for one session without touching others", () => {
    const a = createShareToken("sess-1", "ip", "UA/1")
    const b = createShareToken("sess-1", "ip", "UA/2")
    const c = createShareToken("sess-2", "ip", "UA/3")
    revokeShareTokensForSession("sess-1")
    expect(validateShareToken(a, "UA/1")).toBeNull()
    expect(validateShareToken(b, "UA/2")).toBeNull()
    expect(validateShareToken(c, "UA/3")).toBe("sess-2")
  })

  it("counts live guests per session", () => {
    createShareToken("sess-1", "ip", "UA/1")
    createShareToken("sess-1", "ip", "UA/2")
    createShareToken("sess-2", "ip", "UA/3")
    expect(countShareGuests("sess-1")).toBe(2)
    expect(countShareGuests("sess-2")).toBe(1)
    expect(countShareGuests("sess-3")).toBe(0)
  })

  it("expires on the idle timeout", () => {
    vi.useFakeTimers()
    try {
      const token = createShareToken("sess-1", "ip", "UA/1")
      vi.advanceTimersByTime(1000 * 60 * 60 * 24 * 30)
      expect(validateShareToken(token, "UA/1")).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it("mints tokens with at least 256 bits of entropy", () => {
    expect(createShareToken("sess-1", "ip", "UA/1")).toMatch(/^[0-9a-f]{64}$/)
  })

  it("sets a __Host- cookie that cannot be read by script", () => {
    const headers: string[] = []
    const res = { setHeader: (_n: string, v: string) => headers.push(v) } as never
    setShareCookie(res, "tok")
    expect(headers[0]).toContain("__Host-cogpit_share=tok")
    expect(headers[0]).toContain("HttpOnly")
    expect(headers[0]).toContain("Secure")
    expect(headers[0]).toContain("SameSite=Strict")
    expect(headers[0]).toContain("Path=/")
  })

  it("reads the share token from the cookie only, never a bearer header", () => {
    const withCookie = { headers: { cookie: "__Host-cogpit_share=tok" } } as never
    expect(getRequestShareToken(withCookie)).toBe("tok")
    const withBearer = { headers: { authorization: "Bearer tok" } } as never
    expect(getRequestShareToken(withBearer)).toBeNull()
  })

  it("revokeAllShareTokens clears everything", () => {
    const token = createShareToken("sess-1", "ip", "UA/1")
    revokeAllShareTokens()
    expect(validateShareToken(token, "UA/1")).toBeNull()
  })
})
```

**Step 2: Run and watch it fail.**

**Step 3: Implement** in `server/security.ts`:

```ts
// ── Share token system ───────────────────────────────────────────────
//
// A share token grants full participation in exactly ONE session. It is kept
// in its own map rather than `activeSessions` because a share principal is not
// a team principal: it must never satisfy the main auth path, never persist to
// the team session store, and never appear in getConnectedDevices().

const SHARE_COOKIE = "__Host-cogpit_share"

interface ShareTokenInfo {
  sessionId: string
  createdAt: number
  ip: string
  userAgent: string
  lastActivity: number
}

const shareTokens = new Map<string, ShareTokenInfo>()
```

Then:

- `createShareToken(sessionId, ip, userAgent)` — `randomBytes(32).toString("hex")`, store, return
- `validateShareToken(token, userAgent): string | null` — returns the sessionId. Enforce `SESSION_IDLE_TTL_MS` and `SESSION_ABSOLUTE_TTL_MS`; on expiry or UA mismatch, `shareTokens.delete(token)` and `notifyShareRevoked(token)`, then return null
- `isShareTokenActive(token): boolean` — no `lastActivity` refresh, for stream rechecks
- `revokeShareToken`, `revokeShareTokensForSession(sessionId)`, `revokeAllShareTokens()` — each calls `notifyShareRevoked`
- `countShareGuests(sessionId): number`
- `onShareRevoked(listener)` — mirror `onSessionRevoked` from `[ref §4]`, listener receives the token or `null` for all
- `setShareCookie` / `clearShareCookie` — mirror `setBrowserSessionCookie` but with `SHARE_COOKIE`
- `getRequestShareToken(req)` — `cookieValue(req, SHARE_COOKIE)` **only**. A bearer header must not work: bearer is the machine-client path for full access and a share must never ride it.
- `__resetShareTokensForTest()`

**Step 4: Run and verify green.** 10 passed.

**Step 5: Commit**

```bash
git add server/security.ts server/__tests__/share/tokens.test.ts
git commit -m "feat(share): mint session-scoped guest tokens"
```

---

## Task 6: The allowlist

**Files:**
- Create: `server/share/allowlist.ts`
- Test: `server/__tests__/share/allowlist.test.ts`

A pure function, no HTTP, no I/O. This is the single most important piece of code in the feature: it decides what a guest can reach. Keeping it pure makes it exhaustively testable.

**Step 1: Write the failing test**

```ts
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
    ["PUT", "/api/session-config/sess-1.jsonl"],
    ["GET", "/api/share/session"],
    ["POST", "/api/share/send-message"],
    ["POST", "/api/share/stop"],
    ["POST", "/api/share/interrupt"],
    ["POST", "/api/share/permission"],
    ["POST", "/api/share/answer"],
    ["GET", "/api/hello"],
  ])("%s %s", (method, url) => expect(allow(method, url)).toBe(true))
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

  it("denies an unparseable url", () => {
    expect(allow("GET", "//////")).toBe(false)
  })

  it("denies every method it does not explicitly name", () => {
    expect(allow("DELETE", "/api/session-config/sess-1.jsonl")).toBe(false)
    expect(allow("POST", "/api/sessions/-Users-me-proj/sess-1.jsonl")).toBe(false)
  })
})
```

**Step 2: Run and watch it fail.**

**Step 3: Implement**

```ts
/**
 * What a share guest may reach.
 *
 * Default deny. Every rule names its method and derives the session identity
 * from the request, which must equal the share's. Mutations are absent by
 * design: they live under /api/share/*, where the session comes from the token
 * and there is nothing in the request to compare.
 */

export interface ShareScope {
  sessionId: string
  dirName: string
  fileName: string
}

/** Endpoints under /api/share/ are token-scoped, so the path carries no identity. */
const SHARE_NAMESPACE: ReadonlyArray<readonly [string, string]> = [
  ["GET", "/api/share/session"],
  ["POST", "/api/share/send-message"],
  ["POST", "/api/share/stop"],
  ["POST", "/api/share/interrupt"],
  ["POST", "/api/share/permission"],
  ["POST", "/api/share/answer"],
]

function normalizePath(rawUrl: string): string | null {
  try {
    const decoded = decodeURIComponent(new URL(rawUrl, "http://cogpit.invalid").pathname)
    return new URL(decoded, "http://cogpit.invalid").pathname
  } catch {
    return null
  }
}

export function shareRequestAllowed(method: string, rawUrl: string, share: ShareScope): boolean {
  const path = normalizePath(rawUrl)
  if (path === null) return false
  const verb = method.toUpperCase()
  // ...
}
```

Rules to implement, in this order, all against the **normalized, case-sensitive** path (compare the method uppercased; do **not** lowercase the path — `dirName` and `fileName` are case-sensitive, so instead reject any path whose `/api` prefix is not exactly lowercase):

1. `GET /api/hello` → allow (the client bootstrap; already public anyway).
2. Any `[verb, path]` pair in `SHARE_NAMESPACE` → allow.
3. `GET /api/sessions/<dir>/<file>` → allow iff `dir === share.dirName && file === share.fileName`. Split on `/` and require **exactly** two segments after the prefix, which is what rejects the subagent path.
4. `GET /api/watch/<dir>/<file>` → same check.
5. `GET /api/session-status/<id>`, `GET /api/session-file-changes/<id>` → allow iff `id === share.sessionId` and there are no further segments.
6. `GET|PUT /api/session-config/<key>` → allow iff `key === share.fileName`. A project `dirName` key is denied — that is shared project config, not session config.
7. Everything else → deny.

**Step 4: Run and verify green.** All cases pass.

**Step 5: Commit**

```bash
git add server/share/allowlist.ts server/__tests__/share/allowlist.test.ts
git commit -m "feat(share): default-deny allowlist for guest requests"
```

---

## Task 7: Wire the share branch into both middlewares

**Files:**
- Modify: `server/security.ts` — `authMiddleware` (`:641`) and `teamAuthMiddleware` (`:713`), `PUBLIC_PATHS` (`:626`)
- Test: `server/__tests__/share/auth-branch.test.ts`

This is where a mistake becomes a privilege escalation. `[ref §4]` has both middlewares verbatim; read them before editing.

**The precedence rule:** a valid main bearer/cookie wins. Otherwise, if a share cookie is present, the request enters the share branch and **returns from it** — allowed or denied, it never continues to the full-access paths, including `isTrustedDirectLocalRequest`. A guest who reaches loopback (via a tunnel that terminates locally, or by running a browser on the host) must not be handed the app.

**Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest"

// mock getConfig to a network-enabled server, isTeamEdition to false — see
// server/__tests__/security.test.ts for the established mocking shape

import { authMiddleware, createShareToken, __resetShareTokensForTest } from "../../security"

function run(req: Record<string, unknown>) {
  const res = { statusCode: 200, setHeader: vi.fn(), end: vi.fn(), once: vi.fn(), destroy: vi.fn() }
  const next = vi.fn()
  authMiddleware(req as never, res as never, next as never)
  return { res, next }
}

const REMOTE = { socket: { remoteAddress: "203.0.113.5" } }
const LOOPBACK = { socket: { remoteAddress: "127.0.0.1" } }

beforeEach(() => { __resetShareTokensForTest() })

describe("share branch in authMiddleware", () => {
  it("admits an allowlisted request carrying a valid share cookie", () => {
    const token = createShareToken("sess-1", "203.0.113.5", "UA/1")
    const { next, res } = run({
      ...REMOTE, method: "GET", url: "/api/session-status/sess-1",
      headers: { cookie: `__Host-cogpit_share=${token}`, "user-agent": "UA/1", host: "cogpit.example" },
    })
    expect(next).toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
  })

  it("403s a non-allowlisted request rather than falling through", () => {
    const token = createShareToken("sess-1", "203.0.113.5", "UA/1")
    const { next, res } = run({
      ...REMOTE, method: "GET", url: "/api/projects",
      headers: { cookie: `__Host-cogpit_share=${token}`, "user-agent": "UA/1", host: "cogpit.example" },
    })
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(403)
  })

  it("403s a cross-session request", () => {
    const token = createShareToken("sess-1", "203.0.113.5", "UA/1")
    const { next, res } = run({
      ...REMOTE, method: "GET", url: "/api/session-status/sess-2",
      headers: { cookie: `__Host-cogpit_share=${token}`, "user-agent": "UA/1", host: "cogpit.example" },
    })
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(403)
  })

  // THE escalation test.
  it("does not grant full access to a share cookie arriving on trusted loopback", () => {
    const token = createShareToken("sess-1", "127.0.0.1", "UA/1")
    const { next, res } = run({
      ...LOOPBACK, method: "GET", url: "/api/projects",
      headers: { cookie: `__Host-cogpit_share=${token}`, "user-agent": "UA/1", host: "localhost" },
    })
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(403)
  })

  it("401s an expired or unknown share cookie", () => {
    const { next, res } = run({
      ...REMOTE, method: "GET", url: "/api/session-status/sess-1",
      headers: { cookie: "__Host-cogpit_share=deadbeef", "user-agent": "UA/1", host: "cogpit.example" },
    })
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
  })

  it("requires a trusted mutation source for share mutations", () => {
    const token = createShareToken("sess-1", "203.0.113.5", "UA/1")
    const { next, res } = run({
      ...REMOTE, method: "POST", url: "/api/share/send-message",
      headers: {
        cookie: `__Host-cogpit_share=${token}`, "user-agent": "UA/1",
        host: "cogpit.example", origin: "https://evil.example",
      },
    })
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(403)
  })

  it("lets a full session cookie win over a share cookie", () => {
    // main token + share token both present -> full access path, /api/projects allowed
  })

  it("keeps /api/share/verify public", () => {
    const { next } = run({
      ...REMOTE, method: "POST", url: "/api/share/verify",
      headers: { host: "cogpit.example" },
    })
    expect(next).toHaveBeenCalled()
  })
})
```

Add a parallel `describe` running the same escalation cases through `teamAuthMiddleware` with `isTeamEdition()` mocked true.

**Step 2: Run and watch it fail.**

**Step 3: Implement.** In `authMiddleware`, insert the branch **before** the `isTrustedDirectLocalRequest(req)` early return:

```ts
const shareToken = getRequestShareToken(req)
if (shareToken && !getRequestSessionToken(req)) {
  return handleShareRequest(req, res, next, shareToken)
}
```

And add a module-private `handleShareRequest`:

```ts
/**
 * A share guest's entire request surface. This function always responds or
 * calls next() — it never falls through to the full-access paths below, so a
 * share cookie arriving on loopback cannot be upgraded by the local-trust
 * shortcut.
 */
function handleShareRequest(
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFn,
  token: string,
): void {
  const sessionId = validateShareToken(token, req.headers["user-agent"])
  if (!sessionId) return respond(res, 401, { error: "Share authentication required" })

  const share = getShare(sessionId)
  if (!share) {
    revokeShareToken(token)
    return respond(res, 401, { error: "Share authentication required" })
  }

  const method = (req.method || "GET").toUpperCase()
  if (!SAFE_METHODS.has(method) && !hasTrustedMutationSource(req)) {
    return respond(res, 403, { error: "Untrusted request source" })
  }

  if (!shareRequestAllowed(method, req.url || "/", share)) {
    return respond(res, 403, { error: "Not available on a shared session" })
  }

  touchShare(sessionId)
  trackShareHttpStream(req, res, token)
  next()
}
```

Add `"/api/share/verify"` to `PUBLIC_PATHS`. Apply the identical branch to `teamAuthMiddleware`, inserted before its principal check.

Watch for an import cycle: `security.ts` importing `share/registry.ts` is fine (the registry imports only `atomicJsonFile` and `password-utils`), but `share/registry.ts` must never import `security.ts`.

**Step 4: Run and verify green.** Then `bun run test` in full — `security.test.ts`, `team-auth-middleware.test.ts`, and every route test must still pass untouched.

**Step 5: Commit**

```bash
git add server/security.ts server/__tests__/share/auth-branch.test.ts
git commit -m "feat(share): gate guest requests in both auth middlewares"
```

---

## Task 8: Revoke guest SSE streams

**Files:**
- Modify: `server/security.ts` — `isAuthenticatedHttpStreamRequest` and a new `trackShareHttpStream`
- Test: `server/__tests__/share/stream-revocation.test.ts`

Without this, turning off a share leaves the guest's `/api/watch` SSE connection open and streaming the transcript indefinitely. `[ref §4]` has `trackAuthenticatedHttpStream` verbatim — `trackShareHttpStream` is the same shape against `onShareRevoked` and `isShareTokenActive`.

**Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"
import { createShareToken, revokeShareTokensForSession, __resetShareTokensForTest } from "../../security"

beforeEach(() => { __resetShareTokensForTest() })

describe("share stream revocation", () => {
  it("destroys a guest SSE response when the share is revoked", () => {
    const token = createShareToken("sess-1", "ip", "UA/1")
    const res = { writableEnded: false, destroy: vi.fn(), once: vi.fn(), setHeader: vi.fn() }
    // drive a GET /api/watch/... through the share branch, then:
    revokeShareTokensForSession("sess-1")
    expect(res.destroy).toHaveBeenCalled()
  })

  it("leaves another session's guest stream alone", () => { /* ... */ })

  it("stops rechecking once the response finishes", () => { /* assert the interval is cleared */ })
})
```

**Step 2–4:** fail, implement, pass. Extend `isAuthenticatedHttpStreamRequest` so `/api/share/*` streaming paths are covered if any are added later; `/api/watch/` is already in its list.

**Step 5: Commit**

```bash
git add server/security.ts server/__tests__/share/stream-revocation.test.ts
git commit -m "feat(share): close guest streams when a share is revoked"
```

---

## Task 9: Allowlist completeness test

**Files:**
- Test: `server/__tests__/share/allowlist-completeness.test.ts`

The load-bearing test of the whole feature. It walks `API_ROUTE_REGISTRY`, collects every mounted path, and asserts each is denied to a share guest unless explicitly listed. A route added in a year's time is denied by default, and this test proves it rather than assuming it.

Mirror the `CANONICAL_ROUTE_IDS` idiom in `server/__tests__/api-routes.test.ts` (`[ref §18]`).

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest"
import { API_ROUTE_REGISTRY } from "../../api-routes"
import { shareRequestAllowed } from "../../share/allowlist"
import type { UseFn } from "../../http"

const SHARE = { sessionId: "sess-1", dirName: "-Users-me-proj", fileName: "sess-1.jsonl" }

/** Every path any route module mounts, collected by running the registry. */
function mountedPaths(): string[] {
  const paths: string[] = []
  const use: UseFn = (path) => { paths.push(path) }
  for (const route of API_ROUTE_REGISTRY) route.register(use, { mode: "dev" })
  return paths
}

/**
 * The complete set of mount prefixes a share guest may reach. Adding a path
 * here widens what a guest can do to the host machine — justify it in review.
 */
const SHARE_REACHABLE = new Set([
  "/api/hello",
  "/api/sessions/",
  "/api/watch/",
  "/api/session-status/",
  "/api/session-file-changes/",
  "/api/session-config/",
  "/api/share",
])

describe("share allowlist completeness", () => {
  it("denies every mounted path that is not share-reachable", () => {
    for (const path of mountedPaths()) {
      if (SHARE_REACHABLE.has(path)) continue
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        expect(
          shareRequestAllowed(method, path, SHARE),
          `${method} ${path} must be denied to a share guest`,
        ).toBe(false)
      }
    }
  })

  it("keeps SHARE_REACHABLE honest — every entry is actually mounted", () => {
    const mounted = new Set(mountedPaths())
    for (const path of SHARE_REACHABLE) expect(mounted).toContain(path)
  })
})
```

The second test matters as much as the first: it stops `SHARE_REACHABLE` from accumulating stale entries that silently stop corresponding to anything.

**Commit**

```bash
git add server/__tests__/share/allowlist-completeness.test.ts
git commit -m "test(share): prove new routes default to denied for guests"
```

---

# Phase 3 — Routes

## Task 10: Host share API

**Files:**
- Create: `server/routes/shares.ts`
- Modify: `server/api-routes.ts` (import + `apiRoute("shares", registerShareRoutes)` after `session-status`)
- Modify: `server/team/policy.ts` (`ROUTE_POLICIES.shares`)
- Modify: `server/__tests__/api-routes.test.ts` (`CANONICAL_ROUTE_IDS`)
- Test: `server/__tests__/routes/shares.test.ts`

`[ref §19]` gives the exact four-file diff shape. `[ref §7]` gives the handler idiom — no Express Router, `req.url` is already stripped of the mount prefix, use `sendJson` and `withJsonBody` from `server/http.ts`.

Endpoints, all under normal auth:

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/shares` | `[{ sessionId, dirName, fileName, title, createdAt, lastAccessAt, guests }]` |
| `POST` | `/api/shares` | `{ url, passphrase, share }` — body `{ sessionId }`; resolves `dirName`/`fileName` server-side via `findJsonlPath` so the client cannot point a share at an arbitrary file |
| `POST` | `/api/shares/:sessionId/regenerate` | `{ passphrase }`, and revokes live guest tokens for that session |
| `DELETE` | `/api/shares/:sessionId` | `{ ok: true }`, and revokes live guest tokens |

Policy entry:

```ts
shares: [
  { prefix: "/api/share/verify", requires: "public" },
  { prefix: "/api/share", requires: "public" },
  { prefix: "/api/shares", requires: "admin" },
],
```

The guest namespace is `"public"` at the policy layer because the share branch of the middleware — not team authz — is what gates it. Note the prefix ordering: `requirementFor` resolves longest-prefix-first, and `/api/shares` is longer than `/api/share`, so the host API stays admin-only.

**Tests to write first:**

- `POST /api/shares` with an unknown sessionId → 404, no record created
- `POST /api/shares` returns a passphrase that verifies against the stored hash
- `POST /api/shares` twice on one session → one record, second passphrase wins
- `GET /api/shares` never includes `passwordHash` or a passphrase
- `GET /api/shares` reports a live guest count
- `DELETE` revokes guest tokens (assert `validateShareToken` now returns null)
- regenerate revokes guest tokens and changes the hash
- `DELETE` on an unknown sessionId → 404

**Commit**

```bash
git add server/routes/shares.ts server/api-routes.ts server/team/policy.ts \
        server/__tests__/api-routes.test.ts server/__tests__/routes/shares.test.ts
git commit -m "feat(share): host API for enabling and revoking shares"
```

---

## Task 11: Guest login

**Files:**
- Modify: `server/routes/shares.ts` — add `POST /api/share/verify`
- Test: `server/__tests__/routes/share-login.test.ts`

Model it on `POST /api/auth/verify` (`server/routes/config.ts:205-310`). The behaviors that matter, each its own test:

- **Unknown share and wrong passphrase are indistinguishable.** Both return `401 { error: "Invalid link or passphrase" }`. For an unknown share, still run one `verifyRemotePassword` against `getDummyHash()` so response timing does not reveal which sessions are shared. This is exactly the pattern the team login already uses.
- **Rate limited.** Call `isRateLimited(req)` before any scrypt work → 429.
- **Busy.** `verifyRemotePassword` returning `"busy"` → 429 with a distinct message.
- **HTTPS required for a browser.** When `req.headers["x-cogpit-client"] === "1"` and `canIssueBrowserSession(req)` is false → 426, message naming the tunnel. Mirrors the main login.
- **CSRF.** `hasTrustedMutationSource(req)` false → 403.
- **Success** → `createShareToken`, `setShareCookie`, respond `{ valid: true }`. Never return the token in the body — a guest is always a browser, and a body token would be readable by script.

**Commit**

```bash
git add server/routes/shares.ts server/__tests__/routes/share-login.test.ts
git commit -m "feat(share): guest login endpoint"
```

---

## Task 12: Guest namespace

**Files:**
- Create: `server/routes/share-guest.ts`
- Modify: `server/api-routes.ts`, `server/team/policy.ts`, `server/__tests__/api-routes.test.ts`
- Test: `server/__tests__/routes/share-guest.test.ts`

Six endpoints. Each resolves the sessionId from the share token via `getRequestShareToken` + `validateShareToken`, then delegates to the existing logic. **The request body never carries a sessionId**; if one is present, ignore it rather than trusting it.

| Endpoint | Delegates to |
|---|---|
| `GET /api/share/session` | the registry record plus `getSessionMeta` for the title |
| `POST /api/share/send-message` | the `/api/send-message` handler body (`[ref §10]`) |
| `POST /api/share/stop` | `/api/stop-session` (`[ref §11]`) |
| `POST /api/share/interrupt` | `/api/interrupt-session` (`[ref §11]`) |
| `POST /api/share/permission` | the permission decision path (`[ref §12]`) |
| `POST /api/share/answer` | the ask-user answer path (`[ref §12]`) |

Extract the shared logic out of the existing handlers into functions both can call rather than duplicating it, or have the guest route construct the delegated call. Duplication here means a bug fixed in one path and not the other.

**Tests to write first:**

- each endpoint with no share cookie → 401
- each endpoint with a share cookie for session A and `{ sessionId: "B" }` in the body → acts on A, never B
- `GET /api/share/session` returns only `dirName`, `fileName`, `title`, `provider` — no cwd, no absolute path, no project list
- `POST /api/share/send-message` reaches the same code path as `/api/send-message` with the token's sessionId

**Commit**

```bash
git add server/routes/share-guest.ts server/api-routes.ts server/team/policy.ts \
        server/__tests__/api-routes.test.ts server/__tests__/routes/share-guest.test.ts
git commit -m "feat(share): token-scoped guest endpoints"
```

---

# Phase 4 — Lifecycle

## Task 13: Lifecycle hooks

**Files:**
- Modify: `server/routes/claude-manage.ts` — `/api/delete-session`
- Modify: `server/routes/config.ts` — `POST /api/config`
- Test: `server/__tests__/share/lifecycle.test.ts`

Four behaviors, four tests:

1. **Deleting a session deletes its share.** Otherwise a new session reusing the id would inherit a stranger's access.
2. **Disabling network access revokes live guest tokens but keeps the records.** Re-enabling network access must not silently re-admit guests who were connected before.
3. **Changing the network password does not touch shares.** `POST /api/config` currently calls `revokeAllSessions()` (`[ref §4]`); shares are a separate credential and must survive. Write this test first and watch it fail if `revokeAllShareTokens` gets wired into the wrong place.
4. **Branching or duplicating a session does not copy the share.** Assert the new session has no record.

**Commit**

```bash
git add server/routes/claude-manage.ts server/routes/config.ts server/__tests__/share/lifecycle.test.ts
git commit -m "feat(share): tie share lifetime to its session"
```

**End of phase:** run `bun run test`, `bun run lint`, `bun run typecheck`, `bun run typecheck:tests`. All green before starting Phase 5.

---

# Phase 5 — Frontend

## Task 14: Shared route branch

**Files:**
- Create: `src/lib/sharePath.ts`, `src/components/Shared/SharedRoot.tsx`
- Modify: `src/main.tsx`
- Test: `src/lib/__tests__/sharePath.test.ts`, `src/components/Shared/__tests__/SharedRoot.test.tsx`

`[ref §13]` has `main.tsx` in full — 16 lines, one render, no router.

```tsx
createRoot(rootEl).render(
  <StrictMode>
    <AppErrorBoundary>
      {isSharedPath(window.location.pathname) ? <SharedRoot /> : <DeviceRoot />}
    </AppErrorBoundary>
  </StrictMode>,
)
```

`sharePath.ts` exports `isSharedPath(pathname)` and `sharedSessionId(pathname)` for `/shared/:sessionId`. Test the edges: trailing slash, nested segments, `/sharedxyz` (not a share path), empty id, a device prefix (`/d/abc/shared/x` is **not** a share path — shares do not compose with the hub).

`SharedRoot` calls `GET /api/share/session`. 401 → `SharedLoginScreen`. 200 → the session view. Anything else → an error state, not a spinner that hangs.

**Commit**

```bash
git commit -m "feat(share): branch the app root on the shared route"
```

---

## Task 15: Guest login screen

**Files:**
- Create: `src/components/Shared/SharedLoginScreen.tsx`
- Test: `src/components/Shared/__tests__/SharedLoginScreen.test.tsx`

Mirror `src/components/LoginScreen.tsx` (`[ref §16]`, 184 lines) — same layout, same `X-Cogpit-Client: 1` header, same error handling shape. Differences: the passphrase field is the only input, and it POSTs `/api/share/verify` with `{ sessionId, password }` where `sessionId` comes from the URL.

Tests: renders the field; submits the right body; shows the 401 message; shows a distinct message on 429; shows the tunnel hint on 426; disables the submit button while in flight.

**Commit**

```bash
git commit -m "feat(share): guest login screen"
```

---

## Task 16: Guest session view

**Files:**
- Create: `src/components/Shared/SharedSessionView.tsx`, `src/contexts/ShareScopedProviders.tsx`
- Test: `src/components/Shared/__tests__/SharedSessionView.test.tsx`

**This is the task most likely to exceed its estimate.** `ChatArea` and the input read from `SessionInventoryContext` and `PendingHumanInputContext`, which poll `/api/active-sessions` and `/api/running-processes` — both denied to a guest. Before writing code, read both contexts and enumerate exactly which fields the components you are reusing actually consume. Then write share-scoped providers exposing only those fields, backed by `/api/share/session` and `/api/session-status/:id`.

If a component turns out to need genuinely more than a guest can have, do not widen the allowlist to satisfy it. Report back instead — that is a design question, not an implementation detail.

Reuse `useLiveSession` unchanged: it builds `/api/watch/${dirName}/${fileName}`, which is on the allowlist precisely so this works.

Tests: renders the transcript from a fixture; sends a message through `/api/share/send-message`; renders a permission prompt and posts the decision; shows a terminal state when the share is revoked mid-session (a 401 on any request).

**Commit**

```bash
git commit -m "feat(share): guest session view"
```

---

## Task 17: Share button

**Files:**
- Create: `src/components/ShareButton.tsx`, `src/hooks/useShare.ts`
- Modify: `src/components/FloatingChrome.tsx`
- Test: `src/components/__tests__/ShareButton.test.tsx`, `src/components/__tests__/FloatingChrome.test.tsx` (extend)

`[ref §15]` shows where `useSessionContext()` is already available in `FloatingChrome`.

A `Share2` icon button: ghost when off, accent-filled when on. `FloatingChrome.test.tsx` exists and will need updating for the added control — that is part of this task, not a follow-up.

Popover, off state: one explanatory line, one Enable button.

Popover, on state: the link with a copy button; the passphrase in full immediately after minting and `••••` with a Regenerate button on any later open; a combined **Copy link & passphrase**; a live guest count; Stop sharing.

When `networkAccess` is off (read from the existing config hook), an inline note that the link only works on this machine.

The passphrase must live in component state only — never `localStorage`, never a URL, never a log.

Tests: off state enables sharing and shows the passphrase once; reopening shows `••••`; Regenerate replaces it; Stop sharing clears the button state; the network-off note appears only when network access is off; copy writes both values.

**Commit**

```bash
git commit -m "feat(share): share button and popover"
```

---

## Task 18: Shared sessions list in settings

**Files:**
- Modify: `src/components/ConfigDialog/NetworkAccessSection.tsx`
- Test: extend its existing test file

A compact list under the network settings: session title, when it was shared, guest count, a Revoke button per row, and a Revoke all. Empty state is a single line, not a card.

This is what stops a share from staying open and forgotten. Without it the feature is one toggle away from a permanently exposed machine.

**Commit**

```bash
git commit -m "feat(share): list active shares in network settings"
```

---

# Phase 6 — Documentation and close-out

## Task 19: Docs

**Files:**
- Modify: `docs/self-hosting.md` — a Session sharing section: what a guest can do, that the passphrase is host-code-execution-equivalent, that HTTPS is required, how to revoke
- Modify: `README.md` — one line in the feature list
- Modify: `.claude/deployments.md` if the tunnel setup needs a note

**Commit**

```bash
git commit -m "docs: session sharing"
```

---

## Task 20: Full verification

Run, in order, and paste real output rather than asserting success:

```bash
bun run lint
bun run typecheck
bun run typecheck:tests
bun run test
bun run check:architecture
bun run check:duplicates
```

Then manual QA against a real server, which is the only way to catch the things unit tests structurally cannot:

1. Start the standalone server with `COGPIT_NETWORK_PASSWORD` set and a tunnel in front of it.
2. Share a session. Copy the link and passphrase.
3. Open the link in a **different browser profile** so no main session cookie exists. Confirm the login screen appears.
4. Wrong passphrase → error. Six rapid attempts → 429.
5. Correct passphrase → transcript renders and streams live.
6. Send a message from the guest. Confirm it lands in the host's session.
7. Approve a permission prompt from the guest.
8. From the guest's devtools, try `fetch('/api/projects')`, `fetch('/api/config')`, and `fetch('/api/session-status/<some-other-session-id>')`. **All three must 403.**
9. Stop sharing from the host. The guest's stream must close and the view must state that sharing ended.
10. Confirm `~/.config/cogpit/shares.local.json` is mode 0600 and contains no plaintext passphrase.

Step 8 is the acceptance test for the whole feature. If any of those three succeed, stop and report.

---

# Deferred

Not in scope. Do not build these without asking:

- Attribution of guest messages in the transcript
- Presence beyond a connection count
- Sharing through the multi-device hub
- Read-only shares
- Guest access to subagent transcripts
- Share expiry timers
