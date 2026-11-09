import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import { AtSign, MessageSquare, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useCrewChat } from "@/hooks/useCrewChat"
import type { AgentKind } from "@/lib/agents"
import { CREW_CHAT_MAX_LENGTH, type CrewChatMember } from "../../../shared/contracts/crewChat"
import { CrewAvatar, CrewChatDay, CrewChatRunView } from "./CrewChatRun"
import { crewChatHandleMap, crewChatRuns, crewChatTints } from "./crewChatView"

const NO_MEMBERS: CrewChatMember[] = []
const NO_KINDS: ReadonlyMap<string, AgentKind> = new Map()

/** `kinds` names each member's agent, for its provider mark. */
export function CrewChat({ rootId, kinds = NO_KINDS, active = true }: { rootId: string; kinds?: ReadonlyMap<string, AgentKind>; active?: boolean }) {
  const chat = useCrewChat(rootId, active)
  const [draft, setDraft] = useState("")
  const [membersOpen, setMembersOpen] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const latest = chat.messages.at(-1)?.sequence
  const members = chat.page?.members ?? NO_MEMBERS
  const handles = useMemo(() => crewChatHandleMap(members), [members])
  const tints = useMemo(() => crewChatTints(members, rootId), [members, rootId])
  const byId = useMemo(() => new Map(members.map((member) => [member.sessionId, member])), [members])
  const listening = useMemo(() => members.filter((member) => member.listening).length, [members])
  const runs = useMemo(() => crewChatRuns(chat.messages, rootId), [chat.messages, rootId])

  useEffect(() => { if (active && follow.current) end.current?.scrollIntoView?.({ block: "end" }) }, [active, latest])

  const send = async () => {
    const text = draft.trim()
    if (!text || chat.posting) return
    if (await chat.post(text)) { setDraft((current) => current.trim() === text ? "" : current); follow.current = true }
  }

  return (
    <section aria-label="Crew chat" className="flex h-full min-h-0 flex-col">
      <details className="shrink-0 border-b px-3 py-2" onToggle={(event) => setMembersOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {chat.page ? `${listening} listening · Members & mentions` : "Loading chat…"}
        </summary>
        {membersOpen && <FieldGroup className="max-h-48 gap-2 overflow-y-auto py-2">
          {members.map((member) => (
            <Field key={member.sessionId} orientation="horizontal" className="items-center gap-2">
              <CrewAvatar role={member.sessionId === rootId ? "lead" : "agent"} sessionId={member.sessionId} kinds={kinds} tints={tints} className="size-5" />
              <FieldLabel className="min-w-0 flex-1 items-baseline gap-1.5" htmlFor={`listen-${member.sessionId}`} aria-label={`Listen for ${member.name}`}>
                <span className="truncate">{member.name}</span>
                <span className="truncate text-xs font-normal text-muted-foreground">@{member.handle}</span>
              </FieldLabel>
              <Button variant="ghost" size="icon-xs" disabled={!chat.page?.canPost || !member.canInteract} onClick={() => setDraft((current) => `${current}${current && !/\s$/.test(current) ? " " : ""}@${member.handle} `)} aria-label={`Mention ${member.name}`} title={`Mention @${member.handle}`} className="text-muted-foreground">
                <AtSign data-icon="inline-start" />
              </Button>
              <Switch id={`listen-${member.sessionId}`} size="sm" checked={member.listening} disabled={!member.canInteract || chat.busyMembers.has(member.sessionId)} onCheckedChange={(value) => void chat.setListening(member.sessionId, value)} />
            </Field>
          ))}
        </FieldGroup>}
        <p className="pb-1 text-xs text-muted-foreground">Listening sends short notices while an agent works. @mentions send the full message, even when listening is off.</p>
      </details>
      <ScrollArea className="min-h-0 flex-1" onScrollCapture={(event) => {
        const viewport = event.target as HTMLElement
        follow.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80
      }}>
        {chat.hasOlder && <div className="flex justify-center py-2"><Button variant="ghost" size="xs" disabled={chat.loadingOlder} onClick={() => void chat.older()}>{chat.loadingOlder ? "Loading…" : "Load earlier messages"}</Button></div>}
        {chat.page && chat.messages.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon"><MessageSquare /></EmptyMedia>
              <EmptyTitle>Talk to the crew</EmptyTitle>
              <EmptyDescription>Share a discovery, ask a question, or tag someone for their input.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        <div role="log" aria-label="Shared messages" aria-live="polite" aria-relevant="additions" className="flex flex-col gap-4 px-3 py-3">
          {runs.map((run) => (
            <Fragment key={run.messages[0]!.sequence}>
              {run.day !== undefined && <CrewChatDay day={run.day} />}
              <CrewChatRunView run={run} members={byId} handles={handles} kinds={kinds} tints={tints} rootId={rootId} />
            </Fragment>
          ))}
          <div ref={end} />
        </div>
      </ScrollArea>
      <form className="shrink-0 border-t p-3" onSubmit={(event) => { event.preventDefault(); void send() }}>
        <FieldGroup className="gap-2">
          <Field data-invalid={Boolean(chat.error)}>
            <FieldLabel htmlFor={`crew-chat-${rootId}`} className="sr-only">Message the crew</FieldLabel>
            <Textarea id={`crew-chat-${rootId}`} value={draft} rows={3} maxLength={CREW_CHAT_MAX_LENGTH} placeholder="Message the crew… use @ to tag an agent" disabled={!chat.page?.canPost} aria-invalid={Boolean(chat.error)} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send() }
            }} />
            {chat.error && <p role="alert" className="text-xs text-destructive">{chat.error}</p>}
          </Field>
          <div className="flex items-center gap-2">
            <FieldDescription className="flex-1">{chat.page?.canPost === false ? "You have read access to this crew." : "⌘ / Ctrl + Enter to send"}</FieldDescription>
            <Button type="submit" size="sm" disabled={!chat.page?.canPost || !draft.trim() || chat.posting}><Send data-icon="inline-start" />{chat.posting ? "Sending…" : "Send"}</Button>
          </div>
        </FieldGroup>
      </form>
    </section>
  )
}
