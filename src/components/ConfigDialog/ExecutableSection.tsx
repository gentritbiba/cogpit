import { useEffect, useState } from "react"
import { ChevronDown, ChevronRight, Cpu } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { authFetch } from "@/lib/auth"
import { cn } from "@/lib/utils"
import type {
  ActiveExecutable,
  DetectedExecutableSource,
  ExecutableChoice,
  ExecutableReport,
} from "../../../shared/contracts/agentExecutable"
import { DETECTED_EXECUTABLE_SOURCES } from "../../../shared/contracts/agentExecutable"
import { descriptorFor } from "../../../shared/session/agent-descriptors"
import type { AgentKind } from "../../../shared/session/types"

const SOURCE_LABELS: Record<ExecutableChoice["source"], string> = {
  auto: "Automatic",
  path: "Installed on PATH",
  npm: "Global npm install",
  bundled: "Bundled with Cogpit",
  custom: "Custom path",
}

interface ExecutableSectionProps {
  kind: AgentKind
  value: ExecutableChoice
  onChange: (choice: ExecutableChoice) => void
  disabled: boolean
  /** Bumped after a save so the "now running" line reflects the new choice. */
  reportVersion: number
}

function describeBinary(path: string, version: string | null): string {
  return version ? `v${version} · ${path}` : path
}

function activeStatus(report: ExecutableReport | null, active: ActiveExecutable | null): string {
  if (report === null) return "Checking installed binaries…"
  if (!active) return "No launchable binary for the saved choice — sessions cannot start."
  if (active.version === null) return `${active.path} did not report a version — check the path.`
  return `Now running: ${describeBinary(active.path, active.version)}`
}

function isLaunchable(active: ActiveExecutable | null): boolean {
  return active !== null && active.version !== null
}

/**
 * Picks which binary new sessions of one agent are spawned from. Every option
 * shows the version behind it, so the choice is never a guess about which copy
 * `claude update` just touched.
 */
export function ExecutableSection({ kind, value, onChange, disabled, reportVersion }: ExecutableSectionProps) {
  const { displayName } = descriptorFor(kind)
  const [report, setReport] = useState<ExecutableReport | null>(null)
  const [open, setOpen] = useState(false)
  const groupName = `agent-executable-${kind}`

  useEffect(() => {
    let cancelled = false
    authFetch(`/api/agent-executable/${kind}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: ExecutableReport | null) => {
        if (!cancelled) setReport(data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [kind, reportVersion])

  const candidates = new Map(report?.candidates.map((candidate) => [candidate.source, candidate]) ?? [])
  const active = report?.active ?? null

  const option = (
    source: ExecutableChoice["source"],
    label: string,
    description: React.ReactNode,
    available = true,
  ) => {
    const id = `${groupName}-${source}`
    return (
      <Field key={source} orientation="horizontal">
        <input
          type="radio"
          id={id}
          name={groupName}
          className="mt-1 size-4 shrink-0 accent-primary"
          checked={value.source === source}
          disabled={disabled || !available}
          onChange={() => onChange(source === "custom" ? { source, path: value.path ?? "" } : { source })}
        />
        <FieldContent>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <FieldDescription className="break-all">{description}</FieldDescription>
        </FieldContent>
      </Field>
    )
  }

  const detected = (source: DetectedExecutableSource) => {
    const candidate = candidates.get(source)
    return option(
      source,
      SOURCE_LABELS[source],
      candidate ? describeBinary(candidate.path, candidate.version) : "Not found on this machine.",
      candidate !== undefined || value.source === source,
    )
  }

  const summary = active
    ? `${SOURCE_LABELS[value.source]} · v${active.version ?? "?"}`
    : SOURCE_LABELS[value.source]

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2">
      <CollapsibleTrigger
        render={(
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-between px-0 font-medium hover:bg-transparent"
          />
        )}
      >
        <span className="flex items-center gap-2">
          <Cpu data-icon="inline-start" className="size-4 text-muted-foreground" />
          {displayName} executable
        </span>
        <span className="flex min-w-0 items-center gap-1 text-xs font-normal text-muted-foreground">
          <span className="truncate">{summary}</span>
          {open ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <Field>
          <FieldDescription>
            Which binary new sessions run. Automatic uses your installed CLI unless it is
            older than the copy bundled with Cogpit.
          </FieldDescription>
          <div className="flex flex-col gap-2 pl-1">
            {option("auto", SOURCE_LABELS.auto, "Recommended.")}
            {DETECTED_EXECUTABLE_SOURCES.map(detected)}
            {option("custom", SOURCE_LABELS.custom, (
              <Input
                aria-label={`${displayName} executable path`}
                value={value.source === "custom" ? value.path ?? "" : ""}
                placeholder="/path/to/binary"
                disabled={disabled || value.source !== "custom"}
                onChange={(e) => onChange({ source: "custom", path: e.target.value })}
                className="mt-1"
              />
            ))}
          </div>
          <p
            className={cn("text-xs", isLaunchable(active) ? "text-muted-foreground" : "text-destructive")}
            aria-live="polite"
          >
            {activeStatus(report, active)}
          </p>
        </Field>
      </CollapsibleContent>
    </Collapsible>
  )
}
