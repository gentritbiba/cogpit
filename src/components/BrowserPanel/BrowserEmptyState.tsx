import { useEffect, useRef, useState, type FormEvent } from "react"
import { Check, Copy, Globe, PowerOff, Sparkles, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/Spinner"
import { copyToClipboard } from "@/lib/utils"

/**
 * The states with nothing to render: no CLI on the machine, a browser that is
 * simply not open yet, and a caller whose agents have not browsed yet. None of
 * those is a failure, so each says what happens next instead of what went
 * wrong. The one failure is a browser list the panel has never read.
 */

const INSTALL_COMMAND = "npm i -g agent-browser && agent-browser install"
const COPIED_MS = 1_500

export function BrowserNotInstalled({ onOpenSkill }: { onOpenSkill: () => void }) {
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current)
  }, [])

  async function copy(): Promise<void> {
    if (!(await copyToClipboard(INSTALL_COMMAND))) return
    setCopied(true)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), COPIED_MS)
  }

  return (
    <Empty className="size-full">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Globe /></EmptyMedia>
        <EmptyTitle>Nothing to show yet</EmptyTitle>
        <EmptyDescription>
          This panel streams a real browser the agent drives. That takes the{" "}
          <code className="font-mono">agent-browser</code> command, which is not on this
          machine yet.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex w-full items-center gap-1.5 rounded-md border bg-muted/40 py-1 pl-2.5 pr-1 text-left">
          <code className="min-w-0 flex-1 truncate font-mono text-xs">{INSTALL_COMMAND}</code>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={copied ? "Copied" : "Copy install command"}
            onClick={() => void copy()}
          >
            {copied
              ? <Check data-icon="inline-start" className="text-emerald-500" />
              : <Copy data-icon="inline-start" />}
          </Button>
        </div>
        <Button variant="outline" size="sm" onClick={onOpenSkill}>
          <Sparkles data-icon="inline-start" />
          Install the agent skill…
        </Button>
        <EmptyDescription className="text-xs">
          The skill teaches the agent when to use a named browser and how this panel follows
          along. Installing writes it into your home directory, so it is never done for you.
        </EmptyDescription>
      </EmptyContent>
    </Empty>
  )
}

/** Opens a page in the browser the panel shows; absent when the caller may only watch it. */
type OpenPage = (url: string) => void

export function BrowserStopped({
  name,
  lastUrl,
  onOpen,
}: {
  name: string
  lastUrl: string | null
  onOpen?: OpenPage
}) {
  return (
    <Empty className="size-full">
      <EmptyHeader>
        <EmptyMedia variant="icon"><PowerOff /></EmptyMedia>
        <EmptyTitle>{name} isn&rsquo;t running</EmptyTitle>
        <EmptyDescription>
          {onOpen
            ? "The agent opens it by itself the moment it browses. You can also open a page here and watch from the start."
            : "It shows up here as soon as the agent that uses it opens it again."}
        </EmptyDescription>
      </EmptyHeader>
      {onOpen && (
        <EmptyContent>
          <OpenPageForm lastUrl={lastUrl} onOpen={onOpen} />
        </EmptyContent>
      )}
    </Empty>
  )
}

/**
 * The caller's own browser before any agent of theirs has used it, or no
 * browser at all to show them. What they see here is decided by the server:
 * their agents' browsers, and those of other sessions they can access.
 */
export function BrowserNoneYet({ onOpen }: { onOpen?: OpenPage }) {
  return (
    <Empty className="size-full">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Globe /></EmptyMedia>
        <EmptyTitle>Your agents&rsquo; browsers show up here</EmptyTitle>
        <EmptyDescription>
          When an agent in one of your sessions opens a web page, you can watch it here and
          take over. Other sessions you can access show their browsers too.
        </EmptyDescription>
      </EmptyHeader>
      {onOpen && (
        <EmptyContent>
          <OpenPageForm lastUrl={null} onOpen={onOpen} />
        </EmptyContent>
      )}
    </Empty>
  )
}

function OpenPageForm({ lastUrl, onOpen }: { lastUrl: string | null; onOpen: OpenPage }) {
  // `null` means "offer the last page"; a string is what the user typed.
  const [draft, setDraft] = useState<string | null>(null)
  const url = draft ?? lastUrl ?? ""

  function submit(event: FormEvent): void {
    event.preventDefault()
    const value = url.trim()
    if (value) onOpen(value)
  }

  return (
    <form className="flex w-full items-center gap-2" onSubmit={submit}>
      <Input
        aria-label="Page to open"
        className="h-8 text-sm"
        placeholder="example.com"
        spellCheck={false}
        autoComplete="off"
        value={url}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button type="submit" size="sm" disabled={!url.trim()}>Open</Button>
    </form>
  )
}

/** The browser list has never been read, so there is nothing to connect to. */
export function BrowserListFailed({ message, onRetry }: { message: string; onRetry: () => Promise<void> }) {
  const [retrying, setRetrying] = useState(false)

  async function retry(): Promise<void> {
    setRetrying(true)
    try {
      await onRetry()
    } finally {
      setRetrying(false)
    }
  }

  return (
    <Empty className="size-full">
      <EmptyHeader>
        <EmptyMedia variant="icon"><TriangleAlert /></EmptyMedia>
        <EmptyTitle>Could not load the browsers</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" size="sm" disabled={retrying} onClick={() => void retry()}>
          {retrying && <Spinner data-icon="inline-start" />}
          Retry
        </Button>
      </EmptyContent>
    </Empty>
  )
}
