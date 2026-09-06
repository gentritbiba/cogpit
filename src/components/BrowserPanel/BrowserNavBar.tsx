import { memo, useState, type FormEvent, type KeyboardEvent } from "react"
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw, X } from "lucide-react"
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

/** What the stream is doing: arriving, standing still, or cut off mid-session. */
export type BrowserStreamStatus = "live" | "idle" | "offline"

interface BrowserNavBarProps {
  page: BrowserPage | null
  tabs: BrowserTab[]
  followed: string | null
  /** Left off when there is no stream to report on. */
  status?: BrowserStreamStatus
  onNavigate: (url: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onFollow: (targetId: string) => void
  onCloseTab: (targetId: string) => void
}

function tabLabel(tab: BrowserTab): string {
  if (tab.url === "about:blank" && (!tab.title.trim() || tab.title === "about:blank")) return "New tab"
  if (tab.title.trim()) return tab.title.trim()
  try {
    return new URL(tab.url).hostname || tab.url
  } catch {
    return tab.url
  }
}

/** A still page is normal and a dropped socket is not, so each says so plainly. */
const STREAM_REPORT: Record<BrowserStreamStatus, {
  label: string
  hint: string
  tone: string
  dot: string
}> = {
  live: {
    label: "LIVE",
    hint: "Streaming the page as it changes",
    tone: "text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  idle: {
    label: "IDLE",
    hint: "The page has not changed for a few seconds",
    tone: "text-muted-foreground",
    dot: "ring-1 ring-muted-foreground/50 ring-inset",
  },
  offline: {
    label: "OFFLINE",
    hint: "The connection dropped — this is the last frame that arrived",
    tone: "text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
  },
}

function FrameStatus({ status }: { status: BrowserStreamStatus }) {
  const report = STREAM_REPORT[status]
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "ml-1 flex shrink-0 cursor-default items-center gap-1 text-[10px] font-medium tracking-wide",
              report.tone,
            )}
          />
        }
      >
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", report.dot)} />
        {report.label}
      </TooltipTrigger>
      <TooltipContent>{report.hint}</TooltipContent>
    </Tooltip>
  )
}

export const BrowserNavBar = memo(function BrowserNavBar({
  page,
  tabs,
  followed,
  status,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onFollow,
  onCloseTab,
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
          disabled={!page?.canGoBack}
          onClick={onBack}
        >
          <ArrowLeft data-icon="inline-start" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Forward"
          disabled={!page?.canGoForward}
          onClick={onForward}
        >
          <ArrowRight data-icon="inline-start" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Reload"
          disabled={!page}
          onClick={onReload}
        >
          <RotateCw data-icon="inline-start" />
        </Button>

        <form className="ml-1 min-w-0 flex-1" onSubmit={submit}>
          <InputGroup className="h-7">
            <InputGroupInput
              aria-label="Page URL"
              className="text-xs"
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

      {tabs.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
          {tabs.map((tab) => (
            <div
              key={tab.targetId}
              className={cn(
                "flex max-w-48 shrink-0 items-center rounded-md",
                tab.targetId === followed && "bg-secondary",
              )}
            >
              <Button
                size="xs"
                variant="ghost"
                className="min-w-0 shrink rounded-r-none"
                aria-current={tab.targetId === followed ? "page" : undefined}
                title={tab.title || tab.url}
                onClick={() => onFollow(tab.targetId)}
                onMouseDown={(event) => {
                  if (event.button === 1) event.preventDefault()
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1) return
                  event.preventDefault()
                  onCloseTab(tab.targetId)
                }}
              >
                <span className="truncate">{tabLabel(tab)}</span>
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                className="rounded-l-none"
                aria-label={`Close tab: ${tabLabel(tab)}`}
                title="Close tab"
                onClick={() => onCloseTab(tab.targetId)}
              >
                <X data-icon="inline-start" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
})
