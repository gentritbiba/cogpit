import { useDisclosure, useDisclosureKey } from "./disclosure"
import { ImageIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useToolResultBody } from "@/hooks/useToolResultBody"
import type { ElidedResult } from "../../../shared/session/types"
import { LocalImage } from "./LocalImage"
import { formatResultSize } from "./ToolCallResult"

/** A tool-result image the server kept back: a placeholder until the reader loads it. */
export function ElidedResultImage({ stub, mediaType, alt, id }: { stub: ElidedResult; mediaType: string; alt: string; id: string }): React.ReactElement {
  const [requested, setRequested] = useDisclosure(useDisclosureKey(`image:${stub.ref}`), false)
  const body = useToolResultBody(stub, requested)
  if (body.status === "ready") {
    return <LocalImage src={`data:${mediaType};base64,${body.text}`} alt={alt} id={id} className="my-1.5" maxHeightRem={10} />
  }
  return (
    <div className="my-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <ImageIcon className="size-3.5" aria-hidden="true" />
      <span>{alt} ({formatResultSize(stub.bytes)})</span>
      {body.status === "unavailable" ? <span role="alert">{body.message}</span> : (
        <Button type="button" variant="ghost" size="xs" disabled={body.status === "loading"} onClick={() => setRequested(true)}>
          {body.status === "loading" ? "Loading image…" : "Load image"}
        </Button>
      )}
    </div>
  )
}
