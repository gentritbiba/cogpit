import { useMemo } from "react"
import { useDisclosure, useDisclosureKey, useTimelineState } from "./disclosure"
import { ArrowRight, ChevronDown, ChevronRight, MessagesSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CrewAvatar, CrewChatBody } from "@/components/crew/CrewChatRun"
import { crewChatHandleMap, crewChatTints, type CrewChatRole } from "@/components/crew/crewChatView"
import { useSessionInventoryOptional } from "@/contexts/SessionInventoryContext"
import { fetchCrewChatMessage, useCrewChatMembers } from "@/hooks/useCrewChatMembers"
import { agentKindForDirName, type AgentKind } from "@/lib/agents"
import { crewChatMentions, type CrewChatDeliveryPrompt, type CrewChatMember, type CrewChatMessage } from "../../../shared/contracts/crewChat"

const NO_MEMBERS: CrewChatMember[] = []

/** A crew chat message that reached this session, shown the way the crew's chat shows it. */
export function CrewChatDeliveryCard({ delivery }: { delivery: CrewChatDeliveryPrompt }) {
  const rootId = delivery.rootId ?? ""
  const members = useCrewChatMembers(delivery.rootId) ?? NO_MEMBERS
  const inventory = useSessionInventoryOptional()
  const handles = useMemo(() => crewChatHandleMap(members), [members])
  const tints = useMemo(() => crewChatTints(members, rootId), [members, rootId])
  const authorId = members.find((member) => member.name === delivery.author)?.sessionId
  const dirName = authorId && inventory?.sessions.find((session) => session.sessionId === authorId)?.dirName
  const kinds = useMemo(() => new Map<string, AgentKind>(authorId && dirName ? [[authorId, agentKindForDirName(dirName)]] : []), [authorId, dirName])
  const role: CrewChatRole = authorId ? (authorId === rootId ? "lead" : "agent") : delivery.author === "You" || members.length ? "user" : "agent"
  const [open, setOpen] = useDisclosure(useDisclosureKey(`delivery:${delivery.sequence}`), false)
  // Kept with the disclosure, so a remounted card shows the message without refetching it.
  const [fetched, setFetched] = useTimelineState<{ message: CrewChatMessage | null } | null>(useDisclosureKey(`delivery:${delivery.sequence}:message`), null)
  const message = delivery.text === null ? fetched?.message : undefined
  const text = delivery.text ?? message?.text ?? null
  const mentions = useMemo(() => message?.mentions ?? (text ? crewChatMentions(text, members) : []), [message, text, members])
  const recipients = mentions.flatMap((id) => members.find((member) => member.sessionId === id)?.name ?? [])

  const toggle = () => {
    setOpen(!open)
    if (!open && !fetched && delivery.rootId) void fetchCrewChatMessage(delivery.rootId, delivery.sequence).then((value) => setFetched({ message: value }))
  }

  return (
    <article aria-label={`Crew chat message from ${delivery.author}`} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2.5" title={`Crew chat message ${delivery.sequence}`}>
      <CrewAvatar role={role} sessionId={authorId} kinds={kinds} tints={tints} className="row-span-2 mt-px" />
      <div className="flex min-w-0 items-center gap-1.5 leading-6">
        <span className="truncate text-[13px] font-medium">{delivery.author}</span>
        {delivery.text === null ? (
          <span className="shrink-0 text-xs text-muted-foreground">posted in crew chat</span>
        ) : recipients.length > 0 && (
          <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground" title={`To ${recipients.join(", ")}`}>
            <ArrowRight aria-hidden="true" className="size-3 shrink-0" />
            <span className="sr-only">To</span>
            <span className="truncate">{recipients.join(", ")}</span>
          </span>
        )}
        {delivery.text === null ? delivery.rootId && (
          <Button type="button" variant="ghost" size="xs" aria-expanded={open} onClick={toggle} className="ml-auto text-muted-foreground">
            {open ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}
            {open ? "Hide message" : "Show message"}
          </Button>
        ) : (
          <span className="ml-auto flex shrink-0 items-center gap-1 pl-2 text-xs text-muted-foreground">
            <MessagesSquare aria-hidden="true" className="size-3.5" />
            Crew chat
          </span>
        )}
      </div>
      {(delivery.text !== null || open) && (
        <div className="col-start-2 min-w-0">
          {text !== null ? <CrewChatBody text={text} mentions={mentions} handles={handles} tints={tints} rootId={rootId} />
            : <p className="text-xs text-muted-foreground">{fetched ? "Couldn't load this message from the crew's chat." : "Loading the message…"}</p>}
        </div>
      )}
    </article>
  )
}
