import { useEffect, useRef, useState, type FormEvent } from "react"
import { Check, Copy, Globe, PowerOff, Sparkles } from "lucide-react"
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
import { copyToClipboard } from "@/lib/utils"
import type { SkillInstallResult } from "@/hooks/useBrowserSessions"

/**
 * The two states with nothing to render: no CLI on the machine, and a browser
 * that is simply not open yet. Neither is a failure, so both say what happens
 * next instead of what went wrong.
 */

const INSTALL_COMMAND = "npm i -g agent-browser && agent-browser install"
const COPIED_MS = 1_500

type BrowserEmptyStateProps =
  | { kind: "not-installed"; onInstallSkill: () => Promise<SkillInstallResult> }
  | { kind: "stopped"; name: string; lastUrl: string | null; onOpen: (url: string) => void }

export function BrowserEmptyState(props: BrowserEmptyStateProps) {
  return props.kind === "not-installed"
    ? <NotInstalled onInstallSkill={props.onInstallSkill} />
    : <Stopped name={props.name} lastUrl={props.lastUrl} onOpen={props.onOpen} />
}

function NotInstalled({ onInstallSkill }: { onInstallSkill: () => Promise<SkillInstallResult> }) {
  const [copied, setCopied] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [skill, setSkill] = useState<SkillInstallResult | null>(null)
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

  async function install(): Promise<void> {
    setInstalling(true)
    setSkill(await onInstallSkill())
    setInstalling(false)
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
        <Button variant="outline" size="sm" disabled={installing} onClick={() => void install()}>
          <Sparkles data-icon="inline-start" />
          Install the agent skill
        </Button>
        <EmptyDescription className="text-xs">
          {skill === null && "The skill teaches the agent when to use a named browser and how this panel follows along."}
          {skill?.ok === true && `Installed to ${skill.path}`}
          {skill?.ok === false && skill.error}
        </EmptyDescription>
      </EmptyContent>
    </Empty>
  )
}

function Stopped({
  name,
  lastUrl,
  onOpen,
}: {
  name: string
  lastUrl: string | null
  onOpen: (url: string) => void
}) {
  // `null` means "offer the last page"; a string is what the user typed.
  const [draft, setDraft] = useState<string | null>(null)
  const url = draft ?? lastUrl ?? ""

  function submit(event: FormEvent): void {
    event.preventDefault()
    const value = url.trim()
    if (value) onOpen(value)
  }

  return (
    <Empty className="size-full">
      <EmptyHeader>
        <EmptyMedia variant="icon"><PowerOff /></EmptyMedia>
        <EmptyTitle>{name} isn&rsquo;t running</EmptyTitle>
        <EmptyDescription>
          The agent opens it by itself the moment it browses. You can also open a page here
          and watch from the start.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
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
      </EmptyContent>
    </Empty>
  )
}
