import type { MouseEvent } from "react"
import { GitPullRequest, GitPullRequestDraft } from "lucide-react"
import { cn } from "@/lib/utils"
import type { SessionPullRequest } from "../../shared/session/prLinks"
import { Badge } from "@/components/ui/badge"

interface Props {
  pullRequests?: SessionPullRequest[]
  /**
   * How many chips to show before collapsing the rest into a +N marker. Tight
   * surfaces such as session rows pass 1; the status bar has room for a few.
   * Ignored by the list layout, which has room for all of them.
   */
  max?: number
  /** Smaller type and tighter padding, to match session-row badges. */
  compact?: boolean
  /**
   * "chips" is a row of inline pills; "list" stacks one titled line per pull
   * request, for the hover preview.
   */
  layout?: "chips" | "list"
}

function chipTitle(pr: SessionPullRequest): string {
  return `${pr.title ?? `Pull request #${pr.number}`}\n${pr.repo}${pr.isDraft ? " · draft" : ""}`
}

/** Anchor plumbing every layout shares. */
function linkProps(pr: SessionPullRequest) {
  return {
    href: pr.url,
    target: "_blank",
    rel: "noreferrer",
    // Rows are themselves clickable — opening the PR must not also switch the
    // session behind it.
    onClick: (e: MouseEvent) => e.stopPropagation(),
    "aria-label": `Pull request #${pr.number}`,
    title: chipTitle(pr),
  }
}

/**
 * Links to the pull requests a session opened. In chip form the newest are
 * shown because they are the ones still in play; older ones collapse into a +N
 * marker that names them on hover.
 */
export function PullRequestChips({ pullRequests, max = 3, compact, layout = "chips" }: Props) {
  if (!pullRequests?.length) return null

  if (layout === "list") {
    return (
      <div className="flex flex-col gap-0.5">
        {pullRequests.map((pr) => {
          const Icon = pr.isDraft ? GitPullRequestDraft : GitPullRequest
          return (
            <a
              key={pr.url}
              {...linkProps(pr)}
              className="flex items-center gap-1 text-foreground hover:underline"
            >
              <Icon className="size-2.5 shrink-0" />
              <span className="shrink-0">#{pr.number}</span>
              {pr.title && <span className="truncate text-muted-foreground">{pr.title}</span>}
            </a>
          )
        })}
      </div>
    )
  }

  const visible = pullRequests.slice(-max)
  const hidden = pullRequests.slice(0, -max)

  return (
    <>
      {hidden.length > 0 && (
        <span
          className="shrink-0 text-xs text-muted-foreground"
          title={hidden.map((pr) => `#${pr.number} ${pr.title ?? pr.repo}`).join("\n")}
        >
          +{hidden.length}
        </span>
      )}
      {visible.map((pr) => {
        const Icon = pr.isDraft ? GitPullRequestDraft : GitPullRequest
        return (
          <Badge
            key={pr.url}
            variant={pr.isDraft ? "outline" : "secondary"}
            render={<a {...linkProps(pr)} />}
            className={cn("shrink-0", compact && "px-1")}
          >
            <Icon data-icon="inline-start" />
            #{pr.number}
          </Badge>
        )
      })}
    </>
  )
}
