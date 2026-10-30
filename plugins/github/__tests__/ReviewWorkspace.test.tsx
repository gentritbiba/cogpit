import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { GitHubPullReviewResponse, GitHubReviewFile, GitHubReviewGuideRecord } from "@cogpit/plugin-integrations"
import type { GitHubIntegrationRequest, JsonValue } from "@cogpit/plugin-contracts"
import { ReviewHostProvider, ReviewWorkspace, type ReviewHost } from "../ReviewWorkspace"
import { reviewKey } from "../reviewModel"

const head = "b".repeat(40), base = "a".repeat(40), next = "c".repeat(40)
const file = (path: string, extra: Partial<GitHubReviewFile> = {}): GitHubReviewFile => ({
  path, previousPath: null, status: "modified", additions: 1, deletions: 1, blobSha: `${path.length}`.padEnd(40, "e"), patchState: "text",
  patch: "@@ -1,2 +1,2 @@\n context\n-old line\n+new line", ...extra,
})
function page(headSha: string, files: GitHubReviewFile[], nextPage: number | null, pageNumber = 1): GitHubPullReviewResponse {
  return { repository: "acme/app", host: "github.com", number: 7, title: "Add review", url: "https://github.com/acme/app/pull/7", state: "open", baseSha: world.base, headSha, baseBranch: "main", headBranch: "feature", totalFiles: 3, filesCapped: false, page: pageNumber, nextPage, files }
}

const world = vi.hoisted(() => ({
  head: "", base: "", storage: new Map<string, JsonValue>(), guide: null as GitHubReviewGuideRecord | null,
  submit: [] as Array<Record<string, unknown>>, submitResult: [] as Array<() => unknown>, started: [] as unknown[], contexts: [] as unknown[],
}))
const host: ReviewHost = {
  async request<T>(input: GitHubIntegrationRequest): Promise<T> {
    if (input.operation === "pullReview") return (input.page === 2 ? page(world.head, [file("assets/logo.png", { patch: null, patchState: "binary" })], null, 2) : page(world.head, [file("src/a.ts"), file("src/longer.ts")], 2)) as T
    if (input.operation === "reviewGuide") return { repository: "acme/app", number: 7, guide: world.guide } as T
    if (input.operation === "submitReview") { world.submit.push(input); return world.submitResult.shift()!() as T }
    return null as T
  },
  load: async (key) => world.storage.get(key) ?? null,
  save: async (key, value) => { world.storage.set(key, structuredClone(value)) },
  addContext: async (value) => { world.contexts.push(value) },
  start: async (request) => { world.started.push(request) },
  openExternal: vi.fn(),
}
const show = () => render(<ReviewHostProvider value={host}><ReviewWorkspace number={7} onClose={vi.fn()} /></ReviewHostProvider>)

beforeEach(() => {
  Object.assign(world, { head, base, storage: new Map(), guide: null, submit: [], submitResult: [], started: [], contexts: [] })
  Element.prototype.scrollIntoView = vi.fn()
})

describe("pull request review workspace", () => {
  it("shows pinned patches, pages further files and remembers viewed marks per blob", async () => {
    const user = userEvent.setup()
    show()
    expect(await screen.findByText(/feature @ bbbbbbb → main @ aaaaaaa/)).toBeTruthy()
    const first = screen.getByRole("region", { name: "src/a.ts" })
    expect(within(first).getByText("+new line")).toBeTruthy()
    expect(await screen.findByText(/No guide yet/)).toBeTruthy()
    await user.click(within(first).getByRole("checkbox", { name: "Viewed" }))
    expect(screen.getByText(/1\/3 viewed/)).toBeTruthy()
    await user.click(screen.getByRole("button", { name: /Load more files/ }))
    expect(await screen.findByText("Binary file; no patch to show.")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Load more files/ })).toBeNull()
    expect([...world.storage.values()][0]).toMatchObject({ host: "github.com", owner: "acme", name: "app", number: 7, viewed: [file("src/a.ts").blobSha!.slice(0, 12)] })
  })

  it("keeps drafts local with their exact anchor, marks them stale on a new head and never relocates them", async () => {
    const user = userEvent.setup()
    const view = show()
    const first = await screen.findByRole("region", { name: "src/a.ts" })
    await user.click(within(first).getByRole("button", { name: "Comment on head line 2 of src/a.ts" }))
    await user.type(screen.getByRole("textbox", { name: "Draft comment" }), "Name this better")
    await user.click(screen.getByRole("button", { name: "Save draft" }))
    const saved = [...world.storage.values()][0] as { drafts: Array<Record<string, unknown>> }
    expect(saved.drafts).toEqual([expect.objectContaining({ headSha: head, path: "src/a.ts", side: "RIGHT", line: 2, body: "Name this better", excerpt: expect.stringContaining("+new line") })])
    expect(world.submit).toEqual([])
    await user.click(screen.getByRole("button", { name: "Ask the agent to address the draft on line 2" }))
    expect(world.contexts).toEqual([expect.objectContaining({ path: "src/a.ts", startLine: 2, endLine: 2, comment: expect.stringContaining("Name this better") })])

    view.unmount()
    world.head = next
    show()
    const region = await screen.findByRole("region", { name: "src/a.ts" })
    expect(within(region).getByText(/Stale: written on bbbbbbb/)).toBeTruthy()
    expect(screen.getByRole("button", { name: /Submit review/ }).hasAttribute("disabled")).toBe(true)
    expect(screen.getByText(/1 stale/)).toBeTruthy()
  })

  it("submits exactly the shown drafts once, and checks an unconfirmed submission instead of reposting it", async () => {
    const user = userEvent.setup()
    show()
    const first = await screen.findByRole("region", { name: "src/a.ts" })
    await user.click(within(first).getByRole("button", { name: "Comment on base line 2 of src/a.ts" }))
    await user.type(screen.getByRole("textbox", { name: "Draft comment" }), "Why remove this?")
    await user.click(screen.getByRole("button", { name: "Save draft" }))
    await user.click(screen.getByRole("button", { name: /Submit review/ }))
    const confirm = screen.getByRole("region", { name: "Submit review" })
    expect(within(confirm).getByText("Why remove this?")).toBeTruthy()
    world.submitResult.push(() => { throw { code: "unknown_outcome", error: "GitHub did not confirm the review" } })
    await user.click(within(confirm).getByRole("button", { name: "Submit review" }))
    expect(await screen.findByText(/did not confirm the review/)).toBeTruthy()
    const [attempt] = world.submit
    expect(attempt).toMatchObject({ headSha: head, comments: [{ path: "src/a.ts", side: "LEFT", line: 2, body: "Why remove this?" }] })
    world.submitResult.push(() => ({ repository: "acme/app", number: 7, outcome: "already-submitted", headSha: head, reviewId: 41, url: "https://github.com/acme/app/pull/7#pullrequestreview-41" }))
    await user.click(screen.getByRole("button", { name: "Check and finish it" }))
    expect(await screen.findByText(/already had this review/)).toBeTruthy()
    expect(world.submit[1]).toMatchObject({ submissionId: attempt!.submissionId, comments: attempt!.comments })
    expect(([...world.storage.values()][0] as { drafts: unknown[] }).drafts).toEqual([])
  })

  it("generates a guide only on request, follows it to its stops and labels it stale after the head moves", async () => {
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByRole("button", { name: "Generate guide" }))
    expect(world.started).toEqual([{ number: 7, headSha: head, purpose: "guide" }])
    world.guide = { state: "ready", baseSha: base, headSha: "d".repeat(40), startedAt: new Date(Date.now() + 1000).toISOString(), finishedAt: "", error: null, guide: {
      summary: "Adds a review workspace.", groups: [{ title: "Model", note: "", files: ["src/longer.ts"] }], risks: ["Paging edge"], questions: [], stops: [{ path: "src/a.ts", line: 2, side: "RIGHT", note: "Check rename" }],
    } }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3100)) })
    expect(await screen.findByText("Adds a review workspace.")).toBeTruthy()
    expect(screen.getByText(/Stale: the pull request changed since/)).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "src/a.ts:2" }))
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled())
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeTruthy()
  })

  it("starts Work on PR through the host with the pinned head", async () => {
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByRole("button", { name: "Work on PR" }))
    expect(world.started).toEqual([{ number: 7, headSha: head, purpose: "work" }])
  })

  const seed = async (submission: Record<string, unknown>) => {
    const draft = { id: "draft-1", headSha: head, baseSha: base, path: "src/a.ts", side: "LEFT", line: 2, body: "original confirmed text", excerpt: "-old line", createdAt: "2026-10-30T00:00:00Z" }
    world.storage.set(await reviewKey({ host: "github.com", owner: "acme", name: "app", number: 7 }), {
      host: "github.com", owner: "acme", name: "app", number: 7, viewed: [], drafts: [draft],
      submission: { id: "original-submission", headSha: head, baseSha: base, body: "summary", comments: [{ path: "src/a.ts", side: "LEFT", line: 2, body: "original confirmed text" }], draftIds: ["draft-1"], at: "2026-10-30T00:00:00Z", ...submission },
    })
  }

  it("reads a submission interrupted mid-request as unconfirmed and checks it under its own id before any new one", async () => {
    const user = userEvent.setup()
    await seed({ state: "pending" })
    show()
    expect(await screen.findByText(/was not confirmed by GitHub/)).toBeTruthy()
    expect(screen.getByRole("button", { name: /Submit review/ }).hasAttribute("disabled")).toBe(true)
    world.submitResult.push(() => ({ repository: "acme/app", number: 7, outcome: "already-submitted", headSha: head, baseSha: base, reviewId: 41, url: null }))
    await user.click(screen.getByRole("button", { name: "Check and finish it" }))
    expect(await screen.findByText(/already had this review/)).toBeTruthy()
    expect(world.submit).toEqual([expect.objectContaining({ submissionId: "original-submission", headSha: head, baseSha: base, body: "summary" })])
  })

  it("retries an unconfirmed submission with its saved payload and keeps a draft edited since", async () => {
    const user = userEvent.setup()
    await seed({ state: "unknown" })
    show()
    const region = await screen.findByRole("region", { name: "src/a.ts" })
    await user.click(within(region).getByRole("button", { name: "Edit" }))
    const editor = screen.getByRole("textbox", { name: "Draft comment" })
    await user.clear(editor); await user.type(editor, "edited after unknown response")
    await user.click(screen.getByRole("button", { name: "Save draft" }))
    world.submitResult.push(() => ({ repository: "acme/app", number: 7, outcome: "submitted", headSha: head, baseSha: base, reviewId: 42, url: null }))
    await user.click(screen.getByRole("button", { name: "Check and finish it" }))
    expect(await screen.findByText("Review submitted to GitHub.")).toBeTruthy()
    expect(world.submit).toEqual([expect.objectContaining({ submissionId: "original-submission", comments: [{ path: "src/a.ts", side: "LEFT", line: 2, body: "original confirmed text" }] })])
    const saved = [...world.storage.values()][0] as { drafts: Array<{ body: string }> }
    expect(saved.drafts.map((draft) => draft.body)).toEqual(["edited after unknown response"])
  })

  it("marks drafts stale when only the base was retargeted, and submits the pinned base", async () => {
    const user = userEvent.setup()
    await seed({ state: "submitted" })
    world.base = next
    show()
    const region = await screen.findByRole("region", { name: "src/a.ts" })
    expect(within(region).getByText(/Stale: written on bbbbbbb over aaaaaaa/)).toBeTruthy()
    expect(screen.getByRole("button", { name: /Submit review/ }).hasAttribute("disabled")).toBe(true)
    await user.click(within(region).getByRole("button", { name: "Comment on head line 2 of src/a.ts" }))
    await user.type(screen.getByRole("textbox", { name: "Draft comment" }), "New base note")
    await user.click(screen.getByRole("button", { name: "Save draft" }))
    await user.click(screen.getByRole("button", { name: /Submit review/ }))
    world.submitResult.push(() => ({ repository: "acme/app", number: 7, outcome: "submitted", headSha: head, baseSha: next, reviewId: 43, url: null }))
    await user.click(within(screen.getByRole("region", { name: "Submit review" })).getByRole("button", { name: "Submit review" }))
    expect(await screen.findByText("Review submitted to GitHub.")).toBeTruthy()
    expect(world.submit.at(-1)).toMatchObject({ headSha: head, baseSha: next, comments: [{ path: "src/a.ts", side: "RIGHT", line: 2, body: "New base note" }] })
  })
})
