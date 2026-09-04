import { useState } from "react"
import { ChevronDown, ChevronRight, Loader2, Users } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Field, FieldDescription } from "@/components/ui/field"
import { useAgentAccounts, type AccountSwitchOutcome } from "@/hooks/useAgentAccounts"
import { cn } from "@/lib/utils"
import type { AccountUsageWindow, AgentAccount } from "../../../shared/contracts/agentAccounts"
import { descriptorFor } from "../../../shared/session/agent-descriptors"
import type { AgentKind } from "../../../shared/session/types"

interface AccountSectionProps {
  kind: AgentKind
  /** Read-only view: the list still shows, switching does not. */
  disabled: boolean
}

const STATUS_LABELS: Record<string, string> = {
  token_expired: "Token expired",
  relogin_required: "Login needed",
  no_credentials: "No credentials",
  keychain_unavailable: "Keychain locked",
  foreign_credential: "Credential mismatch",
  api_key: "API key",
  unavailable: "Usage unavailable",
}

function accountName(account: AgentAccount): string {
  return account.alias ?? account.email
}

function UsageMeter({ label, window }: { label: string; window: AccountUsageWindow | null }) {
  if (!window) return null
  const heavy = window.pct >= 80
  return (
    <span
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      title={window.resetsIn ? `${label} window resets in ${window.resetsIn}` : undefined}
    >
      <span className="w-5">{label}</span>
      <span className="relative h-1 w-16 overflow-hidden rounded-full bg-muted">
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full", heavy ? "bg-destructive" : "bg-primary")}
          style={{ width: `${window.pct}%` }}
        />
      </span>
      <span className="tabular-nums">{Math.round(window.pct)}%</span>
    </span>
  )
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`
}

function outcomeText(outcome: AccountSwitchOutcome, displayName: string): string {
  if (outcome.kind === "failed") return `Switch failed: ${outcome.error}`
  const { result } = outcome
  const parts = [sentence(result.message)]
  if (result.switched) {
    parts.push(result.credentialStore === "keychain"
      ? `Running ${displayName} sessions pick it up within about 30 seconds; restart one to apply it immediately.`
      : `New messages in ${displayName} use it from now on.`)
  }
  return [...parts, ...result.warnings.map(sentence)].join(" ")
}

/**
 * The logins an agent's account switcher manages, with a one-click switch.
 * Renders nothing when no switcher is installed — an empty picker would only
 * advertise a tool the user does not have.
 */
export function AccountSection({ kind, disabled }: AccountSectionProps) {
  const { displayName } = descriptorFor(kind)
  const { report, switchingSlot, outcome, switchTo } = useAgentAccounts(kind)
  const [open, setOpen] = useState(false)

  if (report === null || report.status === "missing") return null

  const accounts = report.status === "ok" ? report.accounts : []
  const active = accounts.find((account) => account.active) ?? null
  const summary = report.status === "error"
    ? "Unavailable"
    : active
      ? `${accountName(active)} · ${accounts.length} account${accounts.length === 1 ? "" : "s"}`
      : `${accounts.length} account${accounts.length === 1 ? "" : "s"}`

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
          <Users data-icon="inline-start" className="size-4 text-muted-foreground" />
          {displayName} accounts
        </span>
        <span className="flex min-w-0 items-center gap-1 text-xs font-normal text-muted-foreground">
          <span className="truncate">{summary}</span>
          {open ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <Field>
          <FieldDescription>
            {report.status === "ok" && `Logins managed by ${report.tool}${report.version ? ` ${report.version}` : ""}. `}
            Switching changes which login {displayName} sessions authenticate with.
          </FieldDescription>

          {report.status === "error" ? (
            <p className="text-xs text-destructive" role="alert">{report.error}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {accounts.map((account) => {
                const switching = switchingSlot === account.slot
                const status = STATUS_LABELS[account.usageStatus]
                return (
                  <li key={account.slot} className="flex items-center gap-3 px-3 py-2">
                    <span className="w-5 shrink-0 text-xs tabular-nums text-muted-foreground">{account.slot}</span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="truncate text-sm font-medium">{accountName(account)}</span>
                        {account.alias && (
                          <span className="truncate text-xs text-muted-foreground">{account.email}</span>
                        )}
                        {account.active && <Badge>Active</Badge>}
                        {account.disabled && <Badge variant="outline">Disabled</Badge>}
                        {status && <Badge variant="destructive">{status}</Badge>}
                      </div>
                      {account.organization && (
                        <span className="truncate text-xs text-muted-foreground">{account.organization}</span>
                      )}
                      {account.usage && (
                        <div className="flex flex-wrap gap-x-4 gap-y-1">
                          <UsageMeter label="5h" window={account.usage.fiveHour} />
                          <UsageMeter label="7d" window={account.usage.sevenDay} />
                        </div>
                      )}
                    </div>
                    {!disabled && !account.active && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={switchingSlot !== null}
                        onClick={() => switchTo(account.slot)}
                        aria-label={`Switch to ${accountName(account)}`}
                      >
                        {switching ? (
                          <>
                            <Loader2 data-icon="inline-start" className="size-3.5 animate-spin" />
                            Switching…
                          </>
                        ) : (
                          "Switch"
                        )}
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          {outcome && (
            <p
              className={cn("text-xs", outcome.kind === "failed" ? "text-destructive" : "text-muted-foreground")}
              aria-live="polite"
              role={outcome.kind === "failed" ? "alert" : "status"}
            >
              {outcomeText(outcome, displayName)}
            </p>
          )}
        </Field>
      </CollapsibleContent>
    </Collapsible>
  )
}
