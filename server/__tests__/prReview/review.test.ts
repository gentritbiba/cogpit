// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const session = vi.hoisted(() => ({ settle: null as null | ((outcome?: string) => void), reply: null as string | null, stop: vi.fn(async () => true), waits: 0 }))
vi.mock("../../lib/sessionWait", () => ({
  waitForSessions: (ids: string[], { signal }: { signal: AbortSignal }) => new Promise((resolve) => {
    session.waits++
    session.settle = (outcome = "completed") => resolve({ timedOut: false, sessions: [{ sessionId: ids[0], outcome }] })
    if (signal.aborted) resolve({ timedOut: false, sessions: [] })
    signal.addEventListener("abort", () => resolve({ timedOut: false, sessions: [] }), { once: true })
  }),
}))
vi.mock("../../lib/sessionResult", () => ({ readSessionResult: async () => ({ turn: { reply: session.reply } }) }))
vi.mock("../../agents/runtimes", async (importOriginal) => ({ ...await importOriginal<Record<string, unknown>>(), runtimeForSession: () => ({ stop: session.stop }) }))

import { parseGuideReply, ReviewGuideStore } from "../../prReview/guides"
import { prepareReviewWorktree } from "../../prReview/start"

const directories: string[] = []
const temp = (prefix: string) => { const path = mkdtempSync(join(tmpdir(), prefix)); directories.push(path); return path }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
const guide = { summary: "Adds review.", groups: [{ title: "Core", note: "start here", files: ["src/a.ts"] }], risks: ["Paging"], questions: [], stops: [{ path: "src/a.ts", line: 4, side: "RIGHT", note: "Check the bound" }] }
const pull = { principal: "owner", host: "github.com", owner: "acme", name: "app", number: 7 }
const pins = { baseSha: "a".repeat(40), headSha: "b".repeat(40) }
const until = async (check: () => Promise<boolean>) => { for (let index = 0; index < 50 && !await check(); index++) await new Promise((resolve) => setTimeout(resolve, 5)) }

describe("review guides", () => {
  it("reads the last valid fenced guide of a reply and ignores anything else", () => {
    expect(parseGuideReply(`Notes\n\`\`\`json\n{"summary": ""}\n\`\`\`\n\n\`\`\`json\n${JSON.stringify(guide)}\n\`\`\``)).toMatchObject({ summary: "Adds review.", stops: [{ line: 4, side: "RIGHT" }] })
    expect(parseGuideReply("No guide here")).toBeNull()
    expect(parseGuideReply("```json\n{\"summary\": \"x\", \"groups\": []}\n```")).toBeNull()
  })

  it("saves a generated guide with its pins, and marks a restart as interrupted", async () => {
    const root = temp("cogpit-guides-")
    const store = new ReviewGuideStore(() => join(root, "guides.json"))
    await expect(store.get(pull)).resolves.toBeNull()
    await store.generate(pull, pins, async () => ({ sessionId: "guide-session" }))
    expect(await store.get(pull)).toMatchObject({ state: "generating", ...pins })
    await expect(store.generate(pull, pins, async () => ({ sessionId: "again" }))).rejects.toMatchObject({ status: 409 })
    session.reply = `\`\`\`json\n${JSON.stringify(guide)}\n\`\`\``
    session.settle!()
    await until(async () => (await store.get(pull))?.state === "ready")
    expect(await store.get(pull)).toMatchObject({ state: "ready", ...pins, guide: { summary: "Adds review." }, error: null })
    expect(await store.get({ ...pull, number: 8 })).toBeNull()
    expect(await store.get({ ...pull, principal: "someone-else" })).toBeNull()

    await store.generate(pull, pins, async () => ({ sessionId: "second" }))
    const restarted = new ReviewGuideStore(() => join(root, "guides.json"))
    expect(await restarted.get(pull)).toMatchObject({ state: "failed", error: expect.stringMatching(/stopped/) })
    session.settle!()
    await until(async () => (await store.get(pull))?.state !== "generating")
  })

  it("keeps a generation waiting for an answer active and cancellable, and stops its session on cancel", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] })
    try {
      session.stop.mockClear()
      const store = new ReviewGuideStore(() => join(temp("cogpit-guides-"), "guides.json"))
      await store.generate(pull, pins, async () => ({ sessionId: "blocked-guide" }))
      const waits = session.waits
      session.reply = null
      session.settle!("needs_input")
      await vi.advanceTimersByTimeAsync(2000)
      expect(session.waits).toBe(waits + 1)
      expect(await store.get(pull)).toMatchObject({ state: "generating" })
      expect(session.stop).not.toHaveBeenCalled()
      expect(store.cancel(pull)).toBe(true)
      await vi.advanceTimersByTimeAsync(0)
      await until(async () => (await store.get(pull))?.state === "cancelled")
      expect(session.stop).toHaveBeenCalledWith("blocked-guide")
    } finally { vi.useRealTimers() }
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  it("cancels a generation and stops its session, and records a session that returned no guide", async () => {
    const store = new ReviewGuideStore(() => join(temp("cogpit-guides-"), "guides.json"))
    await store.generate(pull, pins, async () => ({ sessionId: "cancel-me" }))
    expect(store.cancel(pull)).toBe(true)
    await until(async () => (await store.get(pull))?.state === "cancelled")
    expect(session.stop).toHaveBeenCalledWith("cancel-me")
    await store.generate(pull, pins, async () => ({ sessionId: "silent" }))
    session.reply = "I looked at it."
    session.settle!()
    await until(async () => (await store.get(pull))?.state === "failed")
    expect(await store.get(pull)).toMatchObject({ state: "failed", error: "The review session did not return a guide" })
    await expect(store.generate(pull, pins, async () => { throw new Error("Setup failed") })).rejects.toThrow("Setup failed")
    expect(await store.get(pull)).toMatchObject({ state: "failed", error: "Setup failed" })
  })
})

describe("PR head worktrees", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim()
  function repository() {
    const origin = temp("cogpit-pr-origin-"), work = temp("cogpit-pr-work-")
    git(origin, "init", "-q", "--bare")
    git(work, "init", "-q", "-b", "main"); writeFileSync(join(work, "a.txt"), "base\n"); git(work, "add", "."); git(work, "commit", "-qm", "base")
    const baseSha = git(work, "rev-parse", "HEAD")
    git(work, "remote", "add", "origin", origin); git(work, "push", "-q", "origin", "main")
    git(work, "switch", "-qc", "feature"); writeFileSync(join(work, "a.txt"), "head\n"); git(work, "commit", "-qam", "head")
    const headSha = git(work, "rev-parse", "HEAD")
    git(work, "push", "-q", "origin", "HEAD:refs/pull/7/head"); git(work, "switch", "-q", "main"); git(work, "branch", "-qD", "feature")
    const clone = temp("cogpit-pr-clone-")
    git(clone, "clone", "-q", origin, ".")
    return { clone, baseSha, headSha }
  }
  const run = (cwd: string, args: string[]) => Promise.resolve({ stdout: git(cwd, ...args) })

  it("checks out the pinned head detached, with its base available", async () => {
    const { clone, baseSha, headSha } = repository()
    await prepareReviewWorktree({ number: 7, headSha, baseSha, baseBranch: "main" }, run)(clone, new AbortController().signal)
    expect(git(clone, "rev-parse", "HEAD")).toBe(headSha)
    expect(git(clone, "status", "--porcelain=v2", "--branch")).toContain("# branch.head (detached)")
  })

  it("refuses a head that moved since and a worktree with changes", async () => {
    const { clone, baseSha } = repository()
    await expect(prepareReviewWorktree({ number: 7, headSha: "d".repeat(40), baseSha, baseBranch: "main" }, run)(clone, new AbortController().signal)).rejects.toThrow(/changed since/)
    writeFileSync(join(clone, "a.txt"), "dirty\n")
    await expect(prepareReviewWorktree({ number: 7, headSha: baseSha, baseSha, baseBranch: "main" }, run)(clone, new AbortController().signal)).rejects.toThrow(/has changes/)
  })
})
