import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import ReactMarkdown, { type Components, type Options } from "react-markdown"
import remarkGfm from "remark-gfm"
import { ArrowRight, Bot, ChevronDown, ChevronUp, CircleDot, GitCommitHorizontal, GitPullRequest, UserRound } from "lucide-react"
import { Separator } from "@/components/ui/separator"
import { markdownComponents } from "@/components/timeline/markdown-components"
import { remarkLocalPaths } from "@/components/timeline/localMedia"
import { MarkdownCodeBlock } from "@/components/timeline/MarkdownCodeBlock"
import type { AgentKind } from "@/lib/agents"
import { agentIcon } from "@/lib/agents/presentation"
import { cn } from "@/lib/utils"
import type { CrewChatMember } from "../../../shared/contracts/crewChat"
import { crewMemberTint, displayUrl, gitHubReference, remarkCrewChat, stripLeadingMentions, type CrewChatRole, type CrewChatRun, type StatusTone } from "./crewChatView"

type Handles = ReadonlyMap<string, string>
type Tints = ReadonlyMap<string, CSSProperties>
type Kinds = ReadonlyMap<string, AgentKind>

/** A member's provider mark, tinted with its colour; the lead stays neutral and the user is a person. */
export function CrewAvatar({ role, sessionId, kinds, tints, className }: { role: CrewChatRole; sessionId?: string; kinds: Kinds; tints: Tints; className?: string }) {
  const kind = sessionId ? kinds.get(sessionId) : undefined
  const Icon = role === "user" ? UserRound : kind ? agentIcon(kind) : Bot
  return (
    <span
      aria-hidden="true"
      className={cn("flex size-6 shrink-0 items-center justify-center rounded-full", role === "lead" ? "bg-foreground/[0.08] text-foreground/80" : "bg-muted text-muted-foreground", className)}
      style={role === "agent" && sessionId ? crewMemberTint(sessionId, tints) : undefined}
    >
      <Icon className={role === "user" ? "size-3.5" : "size-3"} />
    </span>
  )
}

function dayLabel(day: number): string {
  const today = new Date().setHours(0, 0, 0, 0)
  if (day === today) return "Today"
  const yesterday = new Date(today)
  if (day === yesterday.setDate(yesterday.getDate() - 1)) return "Yesterday"
  const date = new Date(day)
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", ...(date.getFullYear() !== new Date().getFullYear() && { year: "numeric" }) })
}

export function CrewChatDay({ day }: { day: number }) {
  const label = dayLabel(day)
  return (
    <div role="separator" aria-label={label} className="flex items-center gap-3 text-[11px] text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      {label}
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

export function CrewChatRunView({ run, members, handles, kinds, tints, rootId }: { run: CrewChatRun; members: ReadonlyMap<string, CrewChatMember>; handles: Handles; kinds: Kinds; tints: Tints; rootId: string }) {
  const author = run.messages[0]!.author
  const recipients = run.recipients.flatMap((id) => members.get(id)?.name ?? [])
  return (
    <div className={cn("flex flex-col gap-2.5", run.role === "user" && "-mx-2 rounded-lg bg-muted/50 px-2 py-2")}>
      {run.messages.map((message, index) => (
        <article
          key={message.sequence}
          aria-label={`Message from ${author.name}`}
          className="group/message grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2.5"
        >
          {index === 0 ? (
            <>
              <CrewAvatar role={run.role} sessionId={author.sessionId} kinds={kinds} tints={tints} className="row-span-2 mt-px" />
              <header className="flex min-w-0 items-baseline gap-1.5 leading-6">
                <span className="truncate text-[13px] font-medium">{author.name}</span>
                {recipients.length > 0 && (
                  <span className="flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground" title={`To ${recipients.join(", ")}`}>
                    <ArrowRight aria-hidden="true" className="size-3 shrink-0 translate-y-0.5" />
                    <span className="sr-only">To</span>
                    <span className="truncate">{recipients.join(", ")}</span>
                  </span>
                )}
                <Time at={message.createdAt} className="ml-auto pl-2 text-[11px]" />
              </header>
            </>
          ) : (
            <Time at={message.createdAt} short className="pt-[3px] text-center text-[10px] opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100" />
          )}
          <div className="col-start-2 min-w-0">
            <CrewChatBody text={message.text} mentions={message.mentions} handles={handles} tints={tints} rootId={rootId} />
          </div>
        </article>
      ))}
    </div>
  )
}

function Time({ at, short, className }: { at: number; short?: boolean; className?: string }) {
  const date = new Date(at)
  const label = short
    ? new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).formatToParts(date).filter((part) => part.type === "hour" || part.type === "minute" || (part.type === "literal" && part.value.trim())).map((part) => part.value).join("")
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  return <time dateTime={date.toISOString()} title={date.toLocaleString()} className={cn("shrink-0 tabular-nums text-muted-foreground", className)}>{label}</time>
}

/** A message's text as the chat shows it, without the opening mentions a header already names. */
export const CrewChatBody = memo(function CrewChatBody({ text: source, mentions, handles, tints, rootId }: { text: string; mentions: readonly string[]; handles: Handles; tints: Tints; rootId: string }) {
  const text = stripLeadingMentions(source, mentions, handles)
  const plugins = useMemo<NonNullable<Options["remarkPlugins"]>>(() => [remarkGfm, remarkLocalPaths, [remarkCrewChat, { handles }]], [handles])
  const components = useMemo(() => chatComponents(rootId, tints), [rootId, tints])
  return (
    <Clamp>
      <div className="text-[13px] leading-relaxed text-foreground/90 [overflow-wrap:anywhere]">
        <ReactMarkdown remarkPlugins={plugins} components={components}>{text}</ReactMarkdown>
      </div>
    </Clamp>
  )
})

/** Long reports start folded so the conversation stays scannable. */
function Clamp({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || open) return
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [open])
  const Icon = open ? ChevronUp : ChevronDown
  return (
    <>
      <div ref={ref} className={cn(!open && "max-h-72 overflow-hidden", !open && overflowing && "[mask-image:linear-gradient(to_bottom,black_calc(100%-3rem),transparent)]")}>
        {children}
      </div>
      {overflowing && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="mt-1 inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon aria-hidden="true" className="size-3" />
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </>
  )
}

const TONE: Record<StatusTone, string> = {
  success: "bg-success/10 text-success",
  warning: "bg-warning/12 text-warning",
  destructive: "bg-destructive/10 text-destructive",
}

const REFERENCE_ICON = { pull: GitPullRequest, issue: CircleDot, commit: GitCommitHorizontal }

const MarkdownLink = markdownComponents.a as (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => ReactNode

function chatComponents(rootId: string, tints: Tints): Components {
  return {
    ...markdownComponents,
    p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
    ul: ({ children }) => <ul className="my-1.5 flex list-disc flex-col gap-1 pl-4 marker:text-muted-foreground/60 first:mt-0 last:mb-0">{children}</ul>,
    ol: ({ children, type, start }) => (
      <ol start={start} className={cn("my-1.5 flex flex-col gap-1 pl-5 marker:text-muted-foreground/70 first:mt-0 last:mb-0", type === "a" ? "list-[lower-alpha]" : "list-decimal")}>{children}</ol>
    ),
    li: ({ children }) => <li className="pl-0.5">{children}</li>,
    h1: Heading,
    h2: Heading,
    h3: Heading,
    h4: Heading,
    h5: Heading,
    h6: Heading,
    blockquote: ({ children }) => <blockquote className="my-1.5 border-l-2 pl-2.5 text-muted-foreground">{children}</blockquote>,
    hr: () => <Separator className="my-2.5" />,
    code: (props) => {
      const { children, className } = props
      if (className || typeof children !== "string" || children.includes("\n")) return <MarkdownCodeBlock {...props} />
      return <code className="rounded-[4px] bg-muted px-1 py-px font-mono text-[0.88em] text-foreground/85">{children}</code>
    },
    a: ({ href, children }) => {
      const bare = typeof children === "string" && href !== undefined && displayUrl(href) === displayUrl(children)
      const reference = bare ? gitHubReference(href) : null
      if (reference) {
        const Icon = REFERENCE_ICON[reference.kind]
        return (
          <MarkdownLink href={href} className="inline-flex items-baseline gap-1 rounded-[4px] bg-muted px-1 font-medium text-foreground/85 no-underline hover:bg-accent">
            <Icon aria-hidden="true" className="size-3 shrink-0 translate-y-0.5 text-muted-foreground" />
            {reference.label}
          </MarkdownLink>
        )
      }
      return (
        <MarkdownLink href={href} className="cursor-pointer text-foreground underline decoration-foreground/25 underline-offset-2 hover:decoration-foreground/60">
          {bare ? displayUrl(href!) : children}
        </MarkdownLink>
      )
    },
    span: ({ children, ...props }) => {
      const data = props as Record<string, string | undefined>
      const kind = data["data-crew-token"]
      if (kind === "mention") return <Mention sessionId={data["data-session-id"]} rootId={rootId} tints={tints}>{children}</Mention>
      if (kind === "status") return <span className={cn("rounded-[4px] px-1 py-px text-[0.85em] font-medium", TONE[data["data-tone"] as StatusTone])}>{children}</span>
      if (kind === "sha") return <span className="font-mono text-[0.88em] text-muted-foreground">{children}</span>
      return <span>{children}</span>
    },
  }
}

function Heading({ children }: { children?: ReactNode }) {
  return <p className="mb-1 mt-3 font-semibold text-foreground first:mt-0">{children}</p>
}

function Mention({ sessionId, rootId, tints, children }: { sessionId?: string; rootId: string; tints: Tints; children?: ReactNode }) {
  const style = sessionId && sessionId !== rootId ? crewMemberTint(sessionId, tints) : undefined
  return (
    <span
      style={style}
      className={cn("rounded-[4px] px-0.5 font-medium", !style && (sessionId ? "bg-foreground/[0.08] text-foreground" : "bg-muted text-muted-foreground"))}
    >
      {children}
    </span>
  )
}
