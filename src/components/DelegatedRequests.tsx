/**
 * Questions from sessions this one handed work to — on this machine or another
 * device — shown above the composer so the user answers them without leaving
 * the session that started the work. Renders nothing until one is waiting.
 */

import { ChevronRight, Server } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PendingInputPrompt } from "@/components/PendingInputPrompt"
import { useDelegatedRequests } from "@/hooks/useDelegatedRequests"
import { sessionUrlIdFromFileName } from "@/lib/agents"
import { getActiveDeviceId, LOCAL_DEVICE_ID } from "@/lib/device"
import { revealSessionPath } from "@/lib/revealSession"
import type { DelegatedRequest } from "../../shared/contracts/delegatedRequests"
import type { PendingInputResponse } from "../../shared/contracts/pendingInput"

/** The app path of a delegated session, on its own device. */
function sessionPath(request: DelegatedRequest): string | null {
  if (!request.address) return null
  const { dirName, fileName } = request.address
  const deviceId = request.device?.id ?? getActiveDeviceId()
  const prefix = deviceId === LOCAL_DEVICE_ID ? "" : `/d/${encodeURIComponent(deviceId)}`
  return `${prefix}/${encodeURIComponent(dirName)}/${encodeURIComponent(sessionUrlIdFromFileName(dirName, fileName))}`
}

export function DelegatedRequests({ sessionId }: { sessionId: string | null }) {
  const { requests, responding, respond } = useDelegatedRequests(sessionId)
  if (requests.length === 0) return null

  return (
    <div className="flex flex-col gap-2 px-3 pb-2">
      {requests.map((request) => (
        <DelegatedRequestCard
          key={request.sessionId}
          request={request}
          responding={responding}
          onRespond={(requestId, response) => void respond(request.sessionId, requestId, response)}
        />
      ))}
    </div>
  )
}

function DelegatedRequestCard({
  request,
  responding,
  onRespond,
}: {
  request: DelegatedRequest
  responding: Set<string>
  onRespond: (requestId: string, response: PendingInputResponse) => void
}) {
  const path = sessionPath(request)
  const open = () => {
    if (path) revealSessionPath(path)
  }
  const [pending] = request.waiting
  if (!pending) return null

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Server className="size-3.5" />
        <span className="truncate">
          {request.device ? `Delegated session on ${request.device.name}` : "Delegated session"}
        </span>
        {path && (
          <Button variant="ghost" size="xs" className="ml-auto" onClick={open}>
            Open
            <ChevronRight data-icon="inline-end" />
          </Button>
        )}
      </div>
      <PendingInputPrompt
        key={pending.requestId}
        sessionId={request.sessionId}
        pending={pending}
        queued={request.waiting.length - 1}
        responding={responding.has(pending.requestId)}
        onRespond={onRespond}
        onOpen={open}
      />
    </div>
  )
}
