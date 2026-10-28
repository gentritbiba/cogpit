import { useState } from "react"
import { Loader2, RefreshCw, Slack } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { Field, FieldDescription } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { useSlackLinks } from "@/hooks/useSlackLinks"
import type { SlackConnectionState, SlackLinksReport } from "../../../shared/contracts/slack"
import { SectionTrigger } from "./SectionTrigger"

type LinkRow = SlackLinksReport["links"][number]

const CONNECTION: Record<SlackConnectionState, { label: string; variant: "default" | "outline" | "destructive" }> = {
  connected: { label: "Connected", variant: "default" },
  connecting: { label: "Connecting", variant: "outline" },
  reconnecting: { label: "Reconnecting", variant: "outline" },
  stopped: { label: "Stopped", variant: "destructive" },
  failed: { label: "Failed", variant: "destructive" },
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`
}

/** Who may write to the session and where it may post, in one line. */
function reach(link: LinkRow): string {
  const posts = [plural(link.dms.length, "DM"), ...(link.channels.length ? [plural(link.channels.length, "channel")] : [])].join(" and ")
  return `Listens to ${link.allow.join(", ")} · posts to ${posts} · ${link.postedToday}/${link.dailyCap} posts today`
}

function problems(link: LinkRow): string[] {
  const lines: string[] = []
  if (link.connection.lastError && link.connection.state !== "connected") lines.push(link.connection.lastError)
  if (link.pending.length) {
    const last = link.pending.find((message) => message.lastError)?.lastError
    lines.push(`${plural(link.pending.length, "message")} waiting to reach the session${last ? `: ${last}` : ""}`)
  }
  if (link.uncertain.length) lines.push(`${plural(link.uncertain.length, "message")} may not have arrived; check the session's queue`)
  return lines
}

function summarize(report: SlackLinksReport | null): string {
  if (!report) return "Unavailable"
  const { links } = report
  if (links.length === 0) return "No links"
  if (links.length === 1) return `1 link · ${CONNECTION[links[0].connection.state].label}`
  return `${plural(links.length, "link")} · ${links.filter((link) => link.connection.state === "connected").length} connected`
}

interface LinkItemProps {
  link: LinkRow
  disabled: boolean
  busy: boolean
  onAutoPost: (value: boolean) => void
  onUnlink: () => void
}

function LinkItem({ link, disabled, busy, onAutoPost, onUnlink }: LinkItemProps) {
  const connection = CONNECTION[link.connection.state]
  const name = link.title ?? link.sessionId
  return (
    <li className="flex flex-col gap-2 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={link.sessionId}>
          {link.title ?? `Session ${link.sessionId.slice(0, 8)}`}
        </span>
        <Badge variant="outline">{link.bot}</Badge>
        <Badge variant={connection.variant}>{connection.label}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">{reach(link)}</p>
      {problems(link).map((line) => (
        <p key={line} className="text-xs text-destructive">{line}</p>
      ))}
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch size="sm" aria-label={`Post the session’s answer in the thread for ${name}`} checked={link.autoPost} disabled={disabled || busy} onCheckedChange={onAutoPost} />
          Post the session&rsquo;s answer in the thread
        </span>
        {!disabled && (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onUnlink} aria-label={`Unlink ${name} from ${link.bot}`}>
            {busy && <Loader2 data-icon="inline-start" className="size-3.5 animate-spin" />}
            Unlink
          </Button>
        )}
      </div>
    </li>
  )
}

/**
 * Sessions linked to Slack bots, with what each may do and whether it is
 * connected. Linking and adding bots stay in `cogpit-session slack`, so bot
 * tokens are read from files on the host and never pass through the app.
 */
interface SlackSectionProps {
  disabled: boolean
}

export function SlackSection({ disabled }: SlackSectionProps) {
  const { state, busy, error, refresh, setAutoPost, unlink } = useSlackLinks()
  const [open, setOpen] = useState(false)

  if (state.status === "loading") return null
  const report = state.status === "ok" ? state.report : null
  if (report && !report.available) return null

  const links = report?.links ?? []
  const unlinkedBots = (report?.bots ?? []).filter((bot) => !links.some((link) => link.bot === bot.name))

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2">
      <SectionTrigger icon={Slack} title="Slack links" summary={summarize(report)} open={open} />

      <CollapsibleContent>
        <Field>
          <div className="flex items-start justify-between gap-2">
            <FieldDescription>
              A linked session receives DMs, Assistant threads, thread replies and mentions from the people it
              listens to, and may post only to their DMs and the channels it lists. Add bots and link sessions
              with <code>cogpit-session slack</code>.
            </FieldDescription>
            <Button type="button" size="icon-sm" variant="ghost" onClick={refresh} aria-label="Refresh Slack links">
              <RefreshCw className="size-3.5" />
            </Button>
          </div>

          {state.status === "error" && <p className="text-xs text-destructive" role="alert">{state.error}</p>}

          {links.length > 0 && (
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {links.map((link) => (
                <LinkItem
                  key={link.sessionId}
                  link={link}
                  disabled={disabled}
                  busy={busy === link.sessionId}
                  onAutoPost={(value) => setAutoPost(link.sessionId, value)}
                  onUnlink={() => unlink(link.sessionId)}
                />
              ))}
            </ul>
          )}

          {unlinkedBots.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Not linked: {unlinkedBots.map((bot) => `${bot.name}${bot.teamName ? ` (${bot.teamName})` : ""}`).join(", ")}
            </p>
          )}

          {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
        </Field>
      </CollapsibleContent>
    </Collapsible>
  )
}
