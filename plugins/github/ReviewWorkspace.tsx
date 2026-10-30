import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, ArrowUpRight, Check, MessageSquarePlus, RefreshCw, Sparkles, Wrench } from "lucide-react"
import type { GitHubErrorResponse, GitHubPullReviewResponse, GitHubReviewFile, GitHubReviewGuideResponse, GitHubReviewSide, GitHubSubmitReviewResponse } from "@cogpit/plugin-integrations"
import type { ComposerFileContext, GitHubIntegrationRequest, JsonValue, ReviewStartRequest } from "@cogpit/plugin-contracts"
import { Alert, AlertDescription, Button, cn, Spinner } from "@cogpit/plugin-ui"
import {
  anchorOf, DRAFT_LIMITS, draftsMarkdown, excerptAround, newId, parsePatch, readReview, reviewKey, sameAnchor, viewedMark,
  type ReviewDraft, type ReviewState,
} from "./reviewModel.js"

/**
 * The pull request review workspace (item 9): every changed file's patch,
 * pinned to the base and head it was read at, viewed marks, local draft
 * comments, an explicit submit, "Work on PR" and an optional generated
 * review guide. Opening it reads; it never generates or posts anything.
 */

export interface ReviewHost {
  request<T>(input: GitHubIntegrationRequest): Promise<T>
  load(key: string): Promise<JsonValue>
  save(key: string, value: JsonValue): Promise<void>
  addContext(context: ComposerFileContext): Promise<void>
  start(request: ReviewStartRequest): Promise<void>
  openExternal(url: string): void
}
const HostContext = createContext<ReviewHost | null>(null)
export const ReviewHostProvider = HostContext.Provider
export function useReviewHost(): ReviewHost | null { return useContext(HostContext) }
/** Opens the review workspace for a pull request; null where the host offers none. */
export const ReviewLauncher = createContext<((number: number) => void) | null>(null)

type Pull = Omit<GitHubPullReviewResponse, "files" | "page" | "nextPage">
const GUIDE_POLL_MS = 3000
const GUIDE_REQUEST_MS = 10 * 60_000

function errorText(error: unknown, fallback: string): string {
  return error && typeof error === "object" && "error" in error && typeof (error as GitHubErrorResponse).error === "string" ? (error as GitHubErrorResponse).error
    : error instanceof Error ? error.message : fallback
}
function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : null
}
function fileAnchor(path: string): string { return `review-file-${encodeURIComponent(path)}` }

function DraftEditor({ initial, onSave, onCancel }: { initial: string; onSave: (body: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState(initial)
  // The plugin frame's sandbox blocks form submission, so saving is a plain click.
  return <div className="flex flex-col gap-1 border-y bg-muted/30 p-2">
    <textarea aria-label="Draft comment" autoFocus rows={3} maxLength={DRAFT_LIMITS.bodyChars} className="w-full rounded border bg-background p-1.5 text-xs" value={body} onChange={(event) => setBody(event.target.value)} />
    <div className="flex justify-end gap-1">
      <Button size="xs" variant="ghost" onClick={onCancel}>Cancel</Button>
      <Button size="xs" disabled={!body.trim()} onClick={() => onSave(body.trim())}>Save draft</Button>
    </div>
  </div>
}

function DraftNote({ draft, stale, onEdit, onDelete, onFix }: { draft: ReviewDraft; stale: boolean; onEdit?: () => void; onDelete: () => void; onFix: () => void }) {
  return <div className={cn("flex flex-col gap-1 border-y px-2 py-1.5 text-xs", stale ? "bg-warning/10" : "bg-primary/5")}>
    <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
      <span>Draft · {draft.side === "LEFT" ? "base" : "head"} line {draft.line}</span>
      {stale && <span className="font-medium text-warning">Stale: written on {draft.headSha.slice(0, 7)}</span>}
      <span className="ml-auto flex gap-1">
        <Button size="xs" variant="ghost" onClick={onFix} aria-label={`Ask the agent to address the draft on line ${draft.line}`}><Wrench data-icon="inline-start" />Ask agent</Button>
        {onEdit && <Button size="xs" variant="ghost" onClick={onEdit}>Edit</Button>}
        <Button size="xs" variant="ghost" onClick={onDelete}>Delete</Button>
      </span>
    </div>
    <p className="whitespace-pre-wrap">{draft.body}</p>
  </div>
}

function FileDiff({ file, headSha, review, editing, setEditing, viewed, onViewed, onDraft, onDelete, onFix, highlight }: {
  file: GitHubReviewFile
  headSha: string
  review: ReviewState
  editing: { path: string; side: GitHubReviewSide; line: number; id?: string } | null
  setEditing: (value: { path: string; side: GitHubReviewSide; line: number; id?: string } | null) => void
  viewed: boolean
  onViewed: (viewed: boolean) => void
  onDraft: (anchor: { path: string; side: GitHubReviewSide; line: number; id?: string }, body: string, excerpt: string) => void
  onDelete: (id: string) => void
  onFix: (draft: ReviewDraft) => void
  highlight: { side: GitHubReviewSide; line: number | null } | null
}) {
  const rows = useMemo(() => file.patch ? parsePatch(file.patch) : [], [file.patch])
  const [open, setOpen] = useState(!viewed)
  useEffect(() => { if (highlight) setOpen(true) }, [highlight])
  const drafts = review.drafts.filter((draft) => draft.path === file.path)
  const current = drafts.filter((draft) => draft.headSha === headSha)
  const stale = drafts.filter((draft) => draft.headSha !== headSha)
  const notice = file.patchState === "binary" ? "Binary file; no patch to show." : file.patchState === "too-large" ? "This patch is too large to show here." : file.patchState === "unavailable" ? "GitHub does not list this file's patch." : rows.length === 0 ? "No content changes." : null
  return <section id={fileAnchor(file.path)} aria-label={file.path} className="rounded-md border">
    <header className="flex items-center gap-2 border-b px-2 py-1 text-xs">
      <button type="button" className="min-w-0 flex-1 truncate text-left font-mono" aria-expanded={open} onClick={() => setOpen(!open)}>
        {file.previousPath && file.previousPath !== file.path ? `${file.previousPath} → ${file.path}` : file.path}
      </button>
      <span className="shrink-0 text-[10px] text-muted-foreground">{file.status}{file.additions || file.deletions ? ` · +${file.additions} −${file.deletions}` : ""}{drafts.length ? ` · ${drafts.length} draft${drafts.length === 1 ? "" : "s"}` : ""}</span>
      <label className="flex shrink-0 items-center gap-1 text-[10px]"><input type="checkbox" checked={viewed} disabled={!file.blobSha && file.status !== "removed"} onChange={(event) => { onViewed(event.target.checked); setOpen(!event.target.checked) }} />Viewed</label>
    </header>
    {open && <div className="overflow-x-auto">
      {notice && <p className="px-2 py-1.5 text-xs text-muted-foreground">{notice}</p>}
      {rows.length > 0 && <table className="w-full border-collapse font-mono text-[11px] leading-4"><tbody>
        {rows.map((row, index) => {
          const anchor = anchorOf(row)
          const here = anchor ? current.filter((draft) => sameAnchor(row, draft)) : []
          const editingHere = anchor && editing && editing.path === file.path && editing.side === anchor.side && editing.line === anchor.line
          const highlighted = anchor && highlight && highlight.line === anchor.line && highlight.side === anchor.side
          return [
            <tr key={index} className={cn(row.kind === "add" && "bg-success/10", row.kind === "del" && "bg-destructive/10", row.kind === "hunk" && "bg-muted text-muted-foreground", highlighted && "outline outline-2 outline-primary")}>
              <td className="w-8 select-none px-1 text-right text-muted-foreground">{row.oldLine ?? ""}</td>
              <td className="w-8 select-none px-1 text-right text-muted-foreground">{row.newLine ?? ""}</td>
              <td className="w-5 px-0.5">{anchor && <button type="button" className="text-muted-foreground hover:text-foreground" aria-label={`Comment on ${anchor.side === "LEFT" ? "base" : "head"} line ${anchor.line} of ${file.path}`} onClick={() => setEditing({ path: file.path, ...anchor })}><MessageSquarePlus className="size-3" /></button>}</td>
              <td className="whitespace-pre px-1">{row.kind === "hunk" ? row.text : `${row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}${row.text}`}</td>
            </tr>,
            ...here.map((draft) => <tr key={draft.id}><td colSpan={4}>
              {editing?.id === draft.id
                ? <DraftEditor initial={draft.body} onCancel={() => setEditing(null)} onSave={(body) => onDraft({ path: draft.path, side: draft.side, line: draft.line, id: draft.id }, body, draft.excerpt)} />
                : <DraftNote draft={draft} stale={false} onEdit={() => setEditing({ path: draft.path, side: draft.side, line: draft.line, id: draft.id })} onDelete={() => onDelete(draft.id)} onFix={() => onFix(draft)} />}
            </td></tr>),
            ...(editingHere && !editing.id ? [<tr key={`${index}-new`}><td colSpan={4}><DraftEditor initial="" onCancel={() => setEditing(null)} onSave={(body) => onDraft(editing, body, excerptAround(rows, index))} /></td></tr>] : []),
          ]
        })}
      </tbody></table>}
      {stale.map((draft) => <div key={draft.id}>
        {editing?.id === draft.id
          ? <DraftEditor initial={draft.body} onCancel={() => setEditing(null)} onSave={(body) => onDraft({ path: draft.path, side: draft.side, line: draft.line, id: draft.id }, body, draft.excerpt)} />
          : <DraftNote draft={draft} stale onEdit={() => setEditing({ path: draft.path, side: draft.side, line: draft.line, id: draft.id })} onDelete={() => onDelete(draft.id)} onFix={() => onFix(draft)} />}
        <pre className="overflow-x-auto bg-muted/30 px-2 py-1 font-mono text-[10px] text-muted-foreground">{draft.excerpt}</pre>
      </div>)}
    </div>}
  </section>
}

function Guide({ host, pull, files, onJump }: { host: ReviewHost; pull: Pull; files: readonly GitHubReviewFile[]; onJump: (path: string, line: number | null, side: GitHubReviewSide) => void }) {
  const [state, setState] = useState<GitHubReviewGuideResponse["guide"] | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(() => host.request<GitHubReviewGuideResponse>({ integration: "github", operation: "reviewGuide", number: pull.number })
    .then((response) => { setState(response.guide); setError(null) }, (failure: unknown) => setError(errorText(failure, "Unable to read the review guide"))), [host, pull.number])
  // Set while the host's dialog may still start the generation the user asked for.
  const [requestedAt, setRequestedAt] = useState<number | null>(null)
  useEffect(() => { void refresh() }, [refresh])
  const working = state?.state === "preparing" || state?.state === "generating"
  if (requestedAt !== null && (working || (state && Date.parse(state.startedAt) >= requestedAt) || Date.now() - requestedAt > GUIDE_REQUEST_MS)) setRequestedAt(null)
  const polling = working || requestedAt !== null
  useEffect(() => {
    if (!polling) return
    const timer = window.setInterval(() => { void refresh() }, GUIDE_POLL_MS)
    return () => window.clearInterval(timer)
  }, [polling, refresh])
  const generate = () => {
    setError(null)
    void host.start({ number: pull.number, headSha: pull.headSha, purpose: "guide" }).then(() => setRequestedAt(Date.now()), (failure: unknown) => setError(errorText(failure, "Unable to ask for a guide")))
  }
  const cancel = () => { void host.request({ integration: "github", operation: "cancelReviewGuide", number: pull.number }).then(refresh, (failure: unknown) => setError(errorText(failure, "Unable to cancel"))) }
  const stale = state && (state.headSha !== pull.headSha || state.baseSha !== pull.baseSha)
  const known = new Set(files.map((file) => file.path))
  return <section aria-label="Review guide" className="flex flex-col gap-2 rounded-md border p-2 text-xs">
    <div className="flex items-center gap-2">
      <Sparkles className="size-3.5" aria-hidden />
      <h3 className="font-medium">Review guide</h3>
      {state && <span className="text-[10px] text-muted-foreground">{state.state} · for {state.headSha.slice(0, 7)}</span>}
      {stale && <span className="text-[10px] font-medium text-warning">Stale: the pull request changed since</span>}
      <span className="ml-auto flex gap-1">
        {working ? <Button size="xs" variant="ghost" onClick={cancel}>Cancel</Button>
          : <Button size="xs" variant="outline" onClick={generate}>{state ? "Regenerate" : "Generate guide"}</Button>}
      </span>
    </div>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {state === null && <p className="text-muted-foreground">No guide yet. Generating one starts a review session in a new worktree at this head; nothing is posted.</p>}
    {working && <p role="status" className="flex items-center gap-1 text-muted-foreground"><Spinner className="size-3" />{state.state === "preparing" ? "Preparing the worktree…" : "The review session is reading the change…"}</p>}
    {(state?.state === "failed" || state?.state === "cancelled") && <p className="text-destructive">{state.error ?? "Generation was cancelled."}</p>}
    {state?.guide && <div className={cn("flex flex-col gap-2", stale && "opacity-70")}>
      <p className="whitespace-pre-wrap">{state.guide.summary}</p>
      <ol className="flex list-decimal flex-col gap-1 pl-4">
        {state.guide.groups.map((group, index) => <li key={index}>
          <span className="font-medium">{group.title}</span>{group.note && <span className="text-muted-foreground"> — {group.note}</span>}
          <span className="flex flex-wrap gap-1">{group.files.map((path) => <button key={path} type="button" className={cn("font-mono text-[10px] underline-offset-2 hover:underline", !known.has(path) && "text-muted-foreground")} onClick={() => onJump(path, null, "RIGHT")}>{path}</button>)}</span>
        </li>)}
      </ol>
      {state.guide.risks.length > 0 && <div><h4 className="font-medium">Risks</h4><ul className="list-disc pl-4">{state.guide.risks.map((risk, index) => <li key={index}>{risk}</li>)}</ul></div>}
      {state.guide.questions.length > 0 && <div><h4 className="font-medium">Questions</h4><ul className="list-disc pl-4">{state.guide.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></div>}
      {state.guide.stops.length > 0 && <div><h4 className="font-medium">Stops</h4><ol className="flex list-decimal flex-col gap-0.5 pl-4">{state.guide.stops.map((stop, index) => <li key={index}>
        <button type="button" className="font-mono text-[10px] underline-offset-2 hover:underline" onClick={() => onJump(stop.path, stop.line, stop.side)}>{stop.path}{stop.line ? `:${stop.line}` : ""}</button> {stop.note}
      </li>)}</ol></div>}
    </div>}
  </section>
}

function SubmitReview({ pull, drafts, onCancel, onSubmit, submitting }: { pull: Pull; drafts: ReviewDraft[]; onCancel: () => void; onSubmit: (body: string) => void; submitting: boolean }) {
  const [body, setBody] = useState("")
  return <section aria-label="Submit review" className="flex flex-col gap-2 rounded-md border border-primary/40 p-2 text-xs">
    <h3 className="font-medium">Submit {drafts.length} comment{drafts.length === 1 ? "" : "s"} to GitHub on {pull.headSha.slice(0, 7)}</h3>
    <p className="text-muted-foreground">This posts one review with exactly these comments. Cogpit checks the head again first and never posts twice.</p>
    <ol className="flex flex-col gap-1">{drafts.map((draft) => <li key={draft.id} className="rounded border p-1.5">
      <span className="font-mono text-[10px] text-muted-foreground">{draft.path} · {draft.side === "LEFT" ? "base" : "head"} line {draft.line}</span>
      <p className="whitespace-pre-wrap">{draft.body}</p>
    </li>)}</ol>
    <textarea aria-label="Review summary" rows={2} className="w-full rounded border bg-background p-1.5" placeholder="Optional summary" value={body} onChange={(event) => setBody(event.target.value)} />
    <div className="flex justify-end gap-1">
      <Button size="xs" variant="ghost" onClick={onCancel} disabled={submitting}>Back</Button>
      <Button size="xs" onClick={() => onSubmit(body)} disabled={submitting || (drafts.length === 0 && !body.trim())}>{submitting ? "Submitting…" : "Submit review"}</Button>
    </div>
  </section>
}

export function ReviewWorkspace({ number, onClose }: { number: number; onClose: () => void }) {
  const host = useReviewHost()!
  const [pull, setPull] = useState<Pull | null>(null)
  const [files, setFiles] = useState<GitHubReviewFile[]>([])
  const [nextPage, setNextPage] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [moved, setMoved] = useState(false)
  const [review, setReview] = useState<ReviewState | null>(null)
  const [storageKey, setStorageKey] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ path: string; side: GitHubReviewSide; line: number; id?: string } | null>(null)
  const [highlight, setHighlight] = useState<{ path: string; side: GitHubReviewSide; line: number | null } | null>(null)
  const [submitting, setSubmitting] = useState<"confirm" | "posting" | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [exported, setExported] = useState<string | null>(null)
  const generation = useRef(0)

  const load = useCallback(async () => {
    const run = ++generation.current
    setLoading(true); setError(null); setMoved(false)
    try {
      const first = await host.request<GitHubPullReviewResponse>({ integration: "github", operation: "pullReview", number })
      if (run !== generation.current) return
      const { files: page, nextPage: next, page: _page, ...meta } = first
      setPull(meta); setFiles(page); setNextPage(next)
      const [owner, name] = meta.repository.split("/") as [string, string]
      const identity = { host: meta.host, owner, name, number }
      const key = await reviewKey(identity)
      const saved = readReview(await host.load(key), identity)
      if (run !== generation.current) return
      setStorageKey(key); setReview(saved)
    } catch (failure) {
      if (run === generation.current) setError(errorText(failure, "Unable to load this pull request"))
    } finally { if (run === generation.current) setLoading(false) }
  }, [host, number])
  useEffect(() => { void load() }, [load])

  const loadMore = async () => {
    if (!pull || nextPage === null) return
    setLoading(true)
    try {
      const page = await host.request<GitHubPullReviewResponse>({ integration: "github", operation: "pullReview", number, page: nextPage })
      if (page.headSha !== pull.headSha) { setMoved(true); return }
      setFiles((current) => [...current, ...page.files]); setNextPage(page.nextPage)
    } catch (failure) {
      if (errorCode(failure) === "stale_head") setMoved(true)
      else setError(errorText(failure, "Unable to load more files"))
    } finally { setLoading(false) }
  }

  const persist = async (next: ReviewState) => {
    setReview(next)
    if (!storageKey) return
    try { await host.save(storageKey, next as unknown as JsonValue) } catch (failure) { setNotice(errorText(failure, "Drafts could not be saved; submit or remove some")) }
  }

  if (!pull || !review) {
    return <div className="flex flex-col gap-2 p-3 text-xs">
      <Button size="xs" variant="ghost" className="self-start" onClick={onClose}><ArrowLeft data-icon="inline-start" />Pull requests</Button>
      {loading && <p role="status" className="flex items-center gap-1 text-muted-foreground"><Spinner className="size-3" />Loading #{number}…</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  }

  const current = review.drafts.filter((draft) => draft.headSha === pull.headSha)
  const staleCount = review.drafts.length - current.length
  const viewedCount = files.filter((file) => { const mark = viewedMark(file.blobSha); return mark !== null && review.viewed.includes(mark) }).length

  const saveDraft = (anchor: { path: string; side: GitHubReviewSide; line: number; id?: string }, body: string, excerpt: string) => {
    if (!anchor.id && review.drafts.length >= DRAFT_LIMITS.drafts) { setNotice(`Keep at most ${DRAFT_LIMITS.drafts} drafts; submit or remove some first`); return }
    const drafts = anchor.id
      ? review.drafts.map((draft) => draft.id === anchor.id ? { ...draft, body } : draft)
      : [...review.drafts, { id: newId(), headSha: pull.headSha, path: anchor.path, side: anchor.side, line: anchor.line, body, excerpt, createdAt: new Date().toISOString() }]
    setEditing(null)
    void persist({ ...review, drafts })
  }
  const setViewed = (file: GitHubReviewFile, viewed: boolean) => {
    const mark = viewedMark(file.blobSha)
    if (!mark) return
    const rest = review.viewed.filter((value) => value !== mark)
    void persist({ ...review, viewed: viewed ? [...rest, mark].slice(-DRAFT_LIMITS.viewed) : rest })
  }
  const fix = (draft: ReviewDraft) => {
    void host.addContext({ path: draft.path, startLine: draft.line, endLine: draft.line, text: draft.excerpt || draft.body, comment: `Review comment on PR #${number} (${draft.side === "LEFT" ? "base" : "head"} line ${draft.line} at ${draft.headSha.slice(0, 7)}): ${draft.body}`.slice(0, 2000) })
      .then(() => setNotice("Added to your message as context"), (failure: unknown) => setNotice(errorText(failure, "Unable to add this draft to your message")))
  }
  const jump = (path: string, line: number | null, side: GitHubReviewSide) => {
    setHighlight({ path, line, side })
    document.getElementById(fileAnchor(path))?.scrollIntoView({ block: "start" })
  }

  const submit = async (body: string, retry = review.submission?.state === "unknown" ? review.submission : null) => {
    const submission = retry ?? { id: newId(), headSha: pull.headSha, body, draftIds: current.map((draft) => draft.id), state: "pending" as const, at: new Date().toISOString() }
    const comments = review.drafts.filter((draft) => submission.draftIds.includes(draft.id)).map(({ path, side, line, body: text }) => ({ path, side, line, body: text }))
    setSubmitting("posting"); setNotice(null)
    await persist({ ...review, submission })
    try {
      const result = await host.request<GitHubSubmitReviewResponse>({ integration: "github", operation: "submitReview", number, headSha: submission.headSha, submissionId: submission.id, body: submission.body, comments })
      if (result.outcome === "stale-head") {
        await persist({ ...review, submission: { ...submission, state: "stale", error: "The pull request changed; nothing was posted" } })
        setNotice("The pull request changed before submitting; nothing was posted. Reload to see the new head.")
        setMoved(true)
      } else {
        await persist({ ...review, drafts: review.drafts.filter((draft) => !submission.draftIds.includes(draft.id)), submission: { ...submission, state: "submitted", url: result.url } })
        setNotice(result.outcome === "already-submitted" ? "GitHub already had this review; nothing was posted again." : "Review submitted to GitHub.")
      }
      setSubmitting(null)
    } catch (failure) {
      const unknown = errorCode(failure) === "unknown_outcome"
      await persist({ ...review, submission: { ...submission, state: unknown ? "unknown" : "failed", error: errorText(failure, "The review was not submitted") } })
      setNotice(unknown ? "GitHub did not confirm the review. Check again before writing it anew; Cogpit looks for it first." : errorText(failure, "The review was not submitted; your drafts are kept."))
      setSubmitting(null)
    }
  }

  return <div className="flex h-full min-h-0 flex-col">
    <header className="flex flex-col gap-1 border-b p-2 text-xs">
      <div className="flex items-center gap-1">
        <Button size="xs" variant="ghost" onClick={onClose} aria-label="Back to pull requests"><ArrowLeft /></Button>
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium">{pull.title} <span className="font-mono text-[10px] text-muted-foreground">#{number}</span></h2>
        <Button size="xs" variant="ghost" aria-label="Reload pull request" onClick={() => void load()}><RefreshCw /></Button>
        <Button size="xs" variant="ghost" aria-label={`Open #${number} on GitHub`} onClick={() => host.openExternal(pull.url)}><ArrowUpRight /></Button>
      </div>
      <p className="pl-8 font-mono text-[10px] text-muted-foreground">{pull.headBranch} @ {pull.headSha.slice(0, 7)} → {pull.baseBranch} @ {pull.baseSha.slice(0, 7)}</p>
      <div className="flex flex-wrap items-center gap-1 pl-8">
        <span className="text-[10px] text-muted-foreground">{viewedCount}/{pull.totalFiles} viewed · {current.length} draft{current.length === 1 ? "" : "s"}{staleCount ? ` · ${staleCount} stale` : ""}</span>
        <span className="ml-auto flex gap-1">
          <Button size="xs" variant="outline" onClick={() => void host.start({ number, headSha: pull.headSha, purpose: "work" }).catch((failure: unknown) => setNotice(errorText(failure, "Unable to start a session")))}>Work on PR</Button>
          <Button size="xs" variant="ghost" disabled={review.drafts.length === 0} onClick={() => setExported(exported ? null : draftsMarkdown(review, review.drafts))}>Export drafts</Button>
          <Button size="xs" disabled={current.length === 0 || submitting !== null || moved} onClick={() => setSubmitting("confirm")}><Check data-icon="inline-start" />Submit review…</Button>
        </span>
      </div>
    </header>
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
      {moved && <Alert><AlertDescription>The pull request has a new head. <Button size="xs" variant="link" onClick={() => void load()}>Reload</Button> to review it; drafts on the old head stay where they were and are marked stale.</AlertDescription></Alert>}
      {notice && <p role="status" className="text-xs">{notice}</p>}
      {review.submission?.state === "unknown" && submitting === null && <Alert><AlertDescription>
        A submission at {new Date(review.submission.at).toLocaleTimeString()} was not confirmed by GitHub. <Button size="xs" variant="link" onClick={() => void submit(review.submission!.body, review.submission)}>Check and finish it</Button>
      </AlertDescription></Alert>}
      {review.submission?.state === "submitted" && review.submission.url && <p className="text-xs text-muted-foreground">Last review submitted · <Button size="xs" variant="link" onClick={() => host.openExternal(review.submission!.url!)}>view on GitHub</Button></p>}
      {exported !== null && <textarea aria-label="Drafts as Markdown" readOnly rows={6} className="w-full rounded border bg-background p-1.5 font-mono text-[10px]" value={exported} onFocus={(event) => event.target.select()} />}
      {submitting !== null && <SubmitReview pull={pull} drafts={current} submitting={submitting === "posting"} onCancel={() => setSubmitting(null)} onSubmit={(body) => void submit(body, null)} />}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <Guide host={host} pull={pull} files={files} onJump={jump} />
      {files.map((file) => {
        const mark = viewedMark(file.blobSha)
        return <FileDiff key={`${pull.headSha}:${file.path}`} file={file} headSha={pull.headSha} review={review} editing={editing} setEditing={setEditing}
          viewed={mark !== null && review.viewed.includes(mark)} onViewed={(viewed) => setViewed(file, viewed)}
          onDraft={saveDraft} onDelete={(id) => void persist({ ...review, drafts: review.drafts.filter((draft) => draft.id !== id) })} onFix={fix}
          highlight={highlight?.path === file.path ? highlight : null} />
      })}
      {nextPage !== null && <Button size="sm" variant="outline" disabled={loading} onClick={() => void loadMore()}>{loading ? "Loading…" : `Load more files (${files.length} of ${pull.totalFiles})`}</Button>}
      {pull.filesCapped && nextPage === null && <p className="text-xs text-muted-foreground">GitHub lists only the first 3000 files of a pull request; the rest are on GitHub.</p>}
      {(() => {
        const orphans = review.drafts.filter((draft) => !files.some((file) => file.path === draft.path))
        return orphans.length > 0 && nextPage === null && <section aria-label="Drafts on files not in this pull request" className="rounded-md border p-2 text-xs">
          <h3 className="font-medium">Drafts on files no longer in the change</h3>
          {orphans.map((draft) => <DraftNote key={draft.id} draft={draft} stale onDelete={() => void persist({ ...review, drafts: review.drafts.filter((other) => other.id !== draft.id) })} onFix={() => fix(draft)} />)}
        </section>
      })()}
    </div>
  </div>
}
