import { useState, type FormEvent, type KeyboardEvent } from "react"
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { BrowserServerMessage, BrowserTab } from "../../../shared/browser/protocol"

/**
 * History, address, stream status and tabs for the followed page. The address
 * field shows the live url until the user starts editing; from the first
 * keystroke to Enter, Escape or blur, what they typed is the only thing that
 * can be in there. The panel's own chrome lives here rather than over the page,
 * where it would sit on top of whatever the site draws in that corner.
 */

export type BrowserPage = Extract<BrowserServerMessage, { type: "page" }>

interface BrowserNavBarProps {
  page: BrowserPage | null
  tabs: BrowserTab[]
  followed: string | null
  /** Whether frames are still arriving. Left off when there is no stream to report on. */
  status?: "live" | "idle"
  /** No page to drive — the whole bar is inert rather than lying about what it can do. */
  disabled?: boolean
  onNavigate: (url: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onFollow: (targetId: string) => void
}

function tabLabel(tab: BrowserTab): string {
  if (tab.title.trim()) return tab.title.trim()
  try {
    return new URL(tab.url).hostname || tab.url
  } catch {
    return tab.url
  }
}

/** Whether frames are still arriving. A still page is normal, so it says so plainly. */
function FrameStatus({ status }: { status: "live" | "idle" }) {
  const live = status === "live"
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "ml-1 flex shrink-0 cursor-default items-center gap-1 text-[10px] font-medium tracking-wide",
              live ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
            )}
          />
        }
      >
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 rounded-full",
            live ? "bg-emerald-500" : "ring-1 ring-muted-foreground/50 ring-inset",
          )}
        />
        {live ? "LIVE" : "IDLE"}
      </TooltipTrigger>
      <TooltipContent>
        {live
          ? "Streaming the page as it changes"
          : "The page has not changed for a few seconds"}
      </TooltipContent>
    </Tooltip>
  )
}

export function BrowserNavBar({
  page,
  tabs,
  followed,
  status,
  disabled = false,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onFollow,
}: BrowserNavBarProps) {
  // `null` means "show the live url"; a string is the user's own text.
  const [draft, setDraft] = useState<string | null>(null)
  const liveUrl = page?.url ?? ""

  function submit(event: FormEvent): void {
    event.preventDefault()
    const value = (draft ?? liveUrl).trim()
    setDraft(null)
    if (value) onNavigate(value)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== "Escape") return
    event.preventDefault()
    setDraft(null)
    event.currentTarget.blur()
  }

  return (
    <div className="flex shrink-0 flex-col gap-1 border-b px-2 py-1.5">
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          disabled={disabled || !page?.canGoBack}
          onClick={onBack}
        >
          <ArrowLeft data-icon="inline-start" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Forward"
          disabled={disabled || !page?.canGoForward}
          onClick={onForward}
        >
          <ArrowRight data-icon="inline-start" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Reload"
          disabled={disabled || !page}
          onClick={onReload}
        >
          <RotateCw data-icon="inline-start" />
        </Button>

        <form className="ml-1 min-w-0 flex-1" onSubmit={submit}>
          <InputGroup className="h-7">
            <InputGroupInput
              aria-label="Page URL"
              className="text-xs"
              disabled={disabled}
              placeholder="Enter a URL"
              spellCheck={false}
              autoComplete="off"
              value={draft ?? liveUrl}
              onChange={(event) => setDraft(event.target.value)}
              onFocus={(event) => event.target.select()}
              onBlur={() => setDraft(null)}
              onKeyDown={handleKeyDown}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label="Open in your browser"
                disabled={!liveUrl}
                onClick={() => window.open(liveUrl, "_blank", "noopener,noreferrer")}
              >
                <ExternalLink data-icon="inline-start" />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>

        {status && <FrameStatus status={status} />}
      </div>

      {tabs.length > 1 && (
        <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
          {tabs.map((tab) => (
            <Button
              key={tab.targetId}
              size="xs"
              variant={tab.targetId === followed ? "secondary" : "ghost"}
              className={cn(
                "max-w-40 shrink-0 font-normal text-muted-foreground",
                tab.targetId === followed && "text-foreground",
              )}
              aria-current={tab.targetId === followed ? "page" : undefined}
              disabled={disabled}
              onClick={() => onFollow(tab.targetId)}
            >
              <span className="truncate">{tabLabel(tab)}</span>
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
