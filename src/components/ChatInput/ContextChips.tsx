import { useState, type KeyboardEvent } from "react"
import { FileCode, Globe, MessageSquareQuote, SquareTerminal, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { contextLabel, type ComposerAttachment, type ComposerContextItem, type QuoteSource } from "../../../shared/session/composerContext"
import { attachmentSrc } from "./useImageUpload"

const KIND_ICON = { file: FileCode, terminal: SquareTerminal, quote: MessageSquareQuote, browser: Globe } as const
const KIND_NAME = { file: "File excerpt", terminal: "Terminal selection", quote: "Quoted reply", browser: "Browser annotation" } as const

/** Opens a quote's source; resolves false when the source can no longer be found. */
export type OpenQuoteSource = (source: QuoteSource, text: string) => Promise<boolean>

function Details({ item, image, onOpenQuoteSource }: { item: ComposerContextItem; image?: ComposerAttachment; onOpenQuoteSource?: OpenQuoteSource }) {
  const [sourceMissing, setSourceMissing] = useState(false)
  return (
    <div className="flex max-h-96 min-w-0 flex-col gap-2 text-xs">
      <p className="font-medium">{KIND_NAME[item.kind]}</p>
      {item.kind === "file" && (
        <p className="break-all font-mono text-muted-foreground">
          {item.path}{item.startLine !== undefined && ` · ${item.startLine === item.endLine ? `line ${item.startLine}` : `lines ${item.startLine}–${item.endLine}`}`}
        </p>
      )}
      {item.kind === "file" && item.comment && <p className="whitespace-pre-wrap"><span className="text-muted-foreground">Review comment: </span>{item.comment}</p>}
      {item.kind === "browser" && (
        <>
          <p className="break-all text-muted-foreground">{item.title ? `${item.title} · ` : ""}{item.url}</p>
          <p className="text-muted-foreground">Region {item.region.width}×{item.region.height} at {item.region.x},{item.region.y} of {item.viewport.width}×{item.viewport.height} · {item.browser}{item.tab ? ` · ${item.tab}` : ""}</p>
          {image ? <img src={attachmentSrc(image)} alt={`Captured region of ${item.title || item.url}`} className="max-h-48 rounded border object-contain" /> : <p className="text-muted-foreground">The captured image is attached to the message.</p>}
          {item.note && <p className="whitespace-pre-wrap">{item.note}</p>}
        </>
      )}
      {(item.kind === "terminal" || item.kind === "quote" || (item.kind === "file" && item.text)) && (
        <pre tabIndex={0} className="min-h-0 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono">{item.kind === "file" ? item.text : item.text}</pre>
      )}
      {item.kind === "quote" && onOpenQuoteSource && (
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="xs" onClick={() => { void onOpenQuoteSource(item.source, item.text).then((found) => setSourceMissing(!found)) }}>Go to source</Button>
          {sourceMissing && <span role="status" className="text-muted-foreground">The source is no longer available; the saved quote is kept.</span>}
        </div>
      )}
    </div>
  )
}

/**
 * The typed context a message carries, one chip per item: Enter or click
 * inspects it, Delete or Backspace (or the × button) removes it where it can
 * still be removed.
 */
export function ContextChips({
  items,
  attachments = [],
  onRemove,
  onOpenQuoteSource,
  className,
}: {
  items: readonly ComposerContextItem[]
  attachments?: readonly ComposerAttachment[]
  onRemove?: (id: string) => void
  onOpenQuoteSource?: OpenQuoteSource
  className?: string
}) {
  if (items.length === 0) return null
  return (
    <ul aria-label="Message context" className={cn("flex flex-wrap gap-1.5", className)}>
      {items.map((item) => {
        const Icon = KIND_ICON[item.kind]
        const label = contextLabel(item)
        const image = item.kind === "browser" ? attachments.find((attachment) => attachment.contextId === item.id) : undefined
        const onKeyDown = (event: KeyboardEvent) => {
          if (onRemove && (event.key === "Delete" || event.key === "Backspace")) {
            event.preventDefault()
            onRemove(item.id)
          }
        }
        return (
          <li key={item.id} className="flex max-w-full items-center rounded-md border bg-muted/60 text-xs">
            <Popover>
              <PopoverTrigger
                onKeyDown={onKeyDown}
                className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`${KIND_NAME[item.kind]}: ${label}. Press Enter to inspect${onRemove ? ", Delete to remove" : ""}`}
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate">{label}</span>
              </PopoverTrigger>
              <PopoverContent className="w-96 max-w-[90vw]" align="start">
                <Details item={item} image={image} onOpenQuoteSource={onOpenQuoteSource} />
              </PopoverContent>
            </Popover>
            {onRemove && (
              <Button type="button" variant="ghost" size="icon-xs" className="mr-0.5 size-5" onClick={() => onRemove(item.id)} aria-label={`Remove ${label}`}>
                <X className="size-3" data-icon="icon" />
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
