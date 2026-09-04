import { useState } from "react"
import {
  ArrowUpRight,
  CircleCheck,
  CircleDot,
  CircleSlash,
  GitMerge,
  GitPullRequest,
  MessageSquarePlus,
  User,
  UserCheck,
  UserRoundX,
  X,
} from "lucide-react"
import type {
  GitHubIssue,
  GitHubIssueLabel,
  GitHubIssueLinkedPull,
  GitHubIssueState,
  GitHubIssuesResponse,
} from "../../shared/contracts/github"
import {
  Button,
  cn,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  FilterChip,
  FilterChipCount,
  ScrollArea,
} from "@/plugin-api"
import { Description } from "./Description"
import { ClosedFold, CommentCount, FilterBar, TabEmpty } from "./parts"
import { relativeTime, useNow } from "./time"

type Who = "all" | "assigned" | "opened" | "unassigned"

const STATE_LABEL: Record<GitHubIssueState, string> = {
  open: "Open",
  completed: "Completed",
  not_planned: "Not planned",
}

const RAIL_CLASS: Record<GitHubIssueState, string> = {
  open: "bg-success",
  completed: "bg-info",
  not_planned: "bg-border",
}

function StateGlyph({ state }: { state: GitHubIssueState }) {
  const className = "size-3.5 shrink-0"
  const label = STATE_LABEL[state]
  if (state === "open") return <CircleDot className={cn(className, "text-success")} aria-label={label} />
  if (state === "completed") return <CircleCheck className={cn(className, "text-info")} aria-label={label} />
  return <CircleSlash className={cn(className, "text-muted-foreground")} aria-label={label} />
}

function LabelDot({ label }: { label: GitHubIssueLabel }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ backgroundColor: `#${label.color}` }}
    />
  )
}

/** The prompt handed to an agent: enough to start work without opening GitHub. */
export function issuePrompt(issue: GitHubIssue): string {
  const body = issue.body.trim()
  return [
    `Work on GitHub issue #${issue.number}: ${issue.title}`,
    issue.url,
    ...(body ? ["", body] : []),
  ].join("\n")
}

function AssigneeSignal({ issue, viewer }: { issue: GitHubIssue; viewer: string | null }) {
  if (viewer !== null && issue.assignees.includes(viewer)) {
    return <UserCheck className="size-3 text-info" aria-label="Assigned to you" role="img" />
  }
  if (issue.assignees.length === 0) return null

  const label = `Assigned to ${issue.assignees.join(", ")}`
  return (
    <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground" aria-label={label} title={label}>
      <User className="size-3" aria-hidden />
      {issue.assignees.length > 1 && issue.assignees.length}
    </span>
  )
}

function LinkedPullGlyph({ state }: { state: GitHubIssueLinkedPull["state"] }) {
  if (state === "merged") return <GitMerge className="size-3 text-info" aria-hidden />
  return (
    <GitPullRequest
      className={cn("size-3", state === "closed" ? "text-destructive" : "text-success")}
      aria-hidden
    />
  )
}

function Signals({
  issue,
  viewer,
  onShowPull,
}: {
  issue: GitHubIssue
  viewer: string | null
  onShowPull: () => void
}) {
  const pull = issue.linkedPulls[0]
  return (
    <span className="flex h-5 shrink-0 items-center gap-1.5">
      <AssigneeSignal issue={issue} viewer={viewer} />
      {pull && (
        <button
          type="button"
          className="flex items-center gap-0.5 rounded-sm font-mono text-[10px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/20"
          aria-label={`Pull request #${pull.number} (${pull.state}), show pull requests`}
          title={`Pull request #${pull.number} · ${pull.state}`}
          onClick={onShowPull}
        >
          <LinkedPullGlyph state={pull.state} />
          #{pull.number}
        </button>
      )}
      <CommentCount count={issue.comments} />
    </span>
  )
}

interface IssueRowProps {
  issue: GitHubIssue
  viewer: string | null
  now: number
  onPickLabel: (label: string) => void
  onShowPull: () => void
  composePrompt: ((text: string) => void) | undefined
}

function IssueRow({ issue, viewer, now, onPickLabel, onShowPull, composePrompt }: IssueRowProps) {
  const [open, setOpen] = useState(false)
  const activity = issue.state === "open" ? issue.updatedAt : (issue.closedAt ?? issue.updatedAt)
  const body = issue.body.trim()

  return (
    <article className="relative pl-3" aria-label={issue.title}>
      <span aria-hidden className={cn("absolute inset-y-1 left-0 w-0.5 rounded-full", RAIL_CLASS[issue.state])} />
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="group/issue flex items-start gap-1 pr-1">
          <CollapsibleTrigger
            className="flex min-w-0 flex-1 flex-col rounded-sm px-1 py-1 text-left outline-none hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/20"
            aria-label={`${issue.title} #${issue.number}: ${STATE_LABEL[issue.state]}`}
            aria-expanded={open}
          >
            <span className="flex min-w-0 items-center gap-2">
              <StateGlyph state={issue.state} />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[13px] font-medium leading-5",
                  issue.state !== "open" && "text-muted-foreground",
                )}
              >
                {issue.title}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">#{issue.number}</span>
            </span>
            <span className="flex min-w-0 items-center gap-1.5 pl-[22px] text-[11px] leading-4 text-muted-foreground">
              {issue.author && <span className="shrink-0">{issue.author}</span>}
              {issue.labels.length > 0 && (
                <span className="flex min-w-0 items-center gap-1 truncate">
                  {issue.labels.slice(0, 3).map((label) => (
                    <span key={label.name} className="flex items-center gap-1 truncate">
                      <LabelDot label={label} />
                      <span className="truncate">{label.name}</span>
                    </span>
                  ))}
                  {issue.labels.length > 3 && <span>+{issue.labels.length - 3}</span>}
                </span>
              )}
              <span className="shrink-0">·</span>
              <time className="shrink-0" dateTime={activity} title={new Date(activity).toLocaleString()}>
                {relativeTime(activity, now)}
              </time>
            </span>
          </CollapsibleTrigger>
          <div className="mt-1 flex shrink-0 items-center gap-1">
            <Signals issue={issue} viewer={viewer} onShowPull={onShowPull} />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-6 text-muted-foreground opacity-0 transition-opacity group-hover/issue:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
              aria-label={`Open #${issue.number} on GitHub`}
              onClick={() => window.open(issue.url, "_blank", "noopener,noreferrer")}
            >
              <ArrowUpRight />
            </Button>
          </div>
        </div>
        <CollapsibleContent>
          <div className="flex flex-col gap-3 py-2 pl-[22px] pr-1">
            {body ? <Description body={body} /> : <p className="text-xs leading-5 text-muted-foreground">No description.</p>}

            {issue.labels.length > 0 && (
              <ul className="flex flex-wrap gap-1" aria-label="Labels">
                {issue.labels.map((label) => (
                  <li key={label.name}>
                    <button
                      type="button"
                      className="inline-flex h-5 items-center gap-1 rounded-full border px-1.5 text-[10px] leading-none text-muted-foreground outline-none hover:border-foreground/30 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/20"
                      onClick={() => onPickLabel(label.name)}
                      aria-label={`Only issues labeled ${label.name}`}
                    >
                      <LabelDot label={label} />
                      {label.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-wrap gap-2">
              {composePrompt && (
                <Button type="button" size="xs" onClick={() => composePrompt(issuePrompt(issue))}>
                  <MessageSquarePlus data-icon="inline-start" />
                  Add to prompt
                </Button>
              )}
              <Button
                variant="outline"
                size="xs"
                render={<a href={issue.url} target="_blank" rel="noopener noreferrer" />}
              >
                Open issue on GitHub
                <ArrowUpRight data-icon="inline-end" />
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </article>
  )
}

function matchesWho(issue: GitHubIssue, who: Who, viewer: string | null): boolean {
  if (who === "assigned") return viewer !== null && issue.assignees.includes(viewer)
  if (who === "opened") return viewer !== null && issue.author === viewer
  if (who === "unassigned") return issue.assignees.length === 0
  return true
}

export function IssuesTab({
  data,
  composePrompt,
  onShowPulls,
}: {
  data: GitHubIssuesResponse
  composePrompt: ((text: string) => void) | undefined
  onShowPulls: () => void
}) {
  const [who, setWho] = useState<Who>("all")
  const [label, setLabel] = useState<string | null>(null)
  const now = useNow(false)
  const viewer = data.viewer

  const count = (candidate: Who) => data.issues.filter((issue) => matchesWho(issue, candidate, viewer)).length
  const assignedCount = count("assigned")
  const openedCount = count("opened")
  const unassignedCount = count("unassigned")
  const effectiveWho: Who = (who === "assigned" && assignedCount === 0)
    || (who === "opened" && openedCount === 0)
    || (who === "unassigned" && unassignedCount === 0)
    ? "all"
    : who

  const visible = data.issues.filter((issue) => (
    matchesWho(issue, effectiveWho, viewer)
    && (label === null || issue.labels.some((candidate) => candidate.name === label))
  ))
  const open = visible.filter((issue) => issue.state === "open")
  const closed = visible.filter((issue) => issue.state !== "open")

  if (data.issues.length === 0) {
    return (
      <TabEmpty
        icon={CircleDot}
        title="No issues yet"
        description="Issues opened on this repository will show up here."
      />
    )
  }

  const row = (issue: GitHubIssue) => (
    <IssueRow
      key={issue.number}
      issue={issue}
      viewer={viewer}
      now={now}
      onPickLabel={setLabel}
      onShowPull={onShowPulls}
      composePrompt={composePrompt}
    />
  )

  return (
    <>
      <FilterBar label="Filter issues">
        <FilterChip pressed={effectiveWho === "all"} onClick={() => setWho("all")}>
          All
          <FilterChipCount>{data.issues.length}</FilterChipCount>
        </FilterChip>
        {viewer && (
          <FilterChip
            pressed={effectiveWho === "assigned"}
            disabled={assignedCount === 0}
            onClick={() => setWho("assigned")}
            aria-label="Only issues assigned to you"
          >
            <UserCheck className="size-3" />
            Mine
            <FilterChipCount>{assignedCount}</FilterChipCount>
          </FilterChip>
        )}
        {viewer && (
          <FilterChip
            pressed={effectiveWho === "opened"}
            disabled={openedCount === 0}
            onClick={() => setWho("opened")}
            aria-label="Only issues you opened"
          >
            <User className="size-3" />
            Opened
            <FilterChipCount>{openedCount}</FilterChipCount>
          </FilterChip>
        )}
        <FilterChip
          pressed={effectiveWho === "unassigned"}
          disabled={unassignedCount === 0}
          onClick={() => setWho("unassigned")}
          aria-label="Only unassigned issues"
        >
          <UserRoundX className="size-3" />
          Unassigned
          <FilterChipCount>{unassignedCount}</FilterChipCount>
        </FilterChip>
        {label && (
          <FilterChip pressed onClick={() => setLabel(null)} aria-label={`Clear label filter ${label}`}>
            <span className="max-w-28 truncate">{label}</span>
            <FilterChipCount>{visible.length}</FilterChipCount>
            <X className="size-3" aria-hidden />
          </FilterChip>
        )}
      </FilterBar>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-3 py-3">
          {open.length === 0 ? (
            <p className="px-1 py-3 text-center text-xs text-muted-foreground">Nothing open here.</p>
          ) : (
            open.map(row)
          )}

          {closed.length > 0 && <ClosedFold count={closed.length}>{closed.map(row)}</ClosedFold>}
        </div>
      </ScrollArea>
    </>
  )
}
