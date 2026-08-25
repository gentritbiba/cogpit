/**
 * The inline answer block for a session parked on an MCP elicitation.
 *
 * The CLI blocks the MCP server on this prompt, and it never reaches the
 * transcript, so this card is the only place it can be answered. Schemas the
 * server could not project into `fields` are declined before they ever get
 * here — a prompt this card cannot draw would block the server silently.
 */

import { useMemo, useState } from "react"
import { ExternalLink, Plug } from "lucide-react"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { ElicitationAnswer } from "@/lib/agentPromptsApi"
import type {
  ElicitationContent,
  MissionControlElicitation,
  MissionControlElicitationField,
} from "../../../shared/contracts/agentPrompts"

interface ElicitationPromptProps {
  request: MissionControlElicitation
  responding: boolean
  onAnswer: (requestId: string, answer: ElicitationAnswer) => void
}

/** Form state is kept as text/booleans; numbers are parsed on submit. */
type FieldValues = Record<string, string | boolean>

function initialValues(fields: MissionControlElicitationField[]): FieldValues {
  const values: FieldValues = {}
  for (const field of fields) {
    if (field.type === "boolean") values[field.name] = field.defaultValue === true
    else if (field.defaultValue !== undefined) values[field.name] = String(field.defaultValue)
    else values[field.name] = ""
  }
  return values
}

function toContent(
  fields: MissionControlElicitationField[],
  values: FieldValues,
): ElicitationContent {
  const content: ElicitationContent = {}
  for (const field of fields) {
    const value = values[field.name]
    if (typeof value === "boolean") {
      content[field.name] = value
      continue
    }
    if (value === "") continue
    content[field.name] = field.type === "number" || field.type === "integer"
      ? Number(value)
      : value
  }
  return content
}

function isComplete(
  fields: MissionControlElicitationField[],
  values: FieldValues,
): boolean {
  return fields.every((field) => {
    if (!field.required) return true
    const value = values[field.name]
    if (typeof value === "boolean") return true
    if (value === "") return false
    return field.type === "number" || field.type === "integer"
      ? Number.isFinite(Number(value))
      : true
  })
}

export function ElicitationPrompt({
  request,
  responding,
  onAnswer,
}: ElicitationPromptProps) {
  const [values, setValues] = useState<FieldValues>(() => initialValues(request.fields))
  const complete = useMemo(() => isComplete(request.fields, values), [request.fields, values])
  const server = request.displayName || request.title || request.serverName

  const setValue = (name: string, value: string | boolean) => {
    setValues((prev) => ({ ...prev, [name]: value }))
  }

  const decline = () => onAnswer(request.requestId, { action: "decline" })

  if (request.mode === "url" && request.url) {
    const url = request.url
    return (
      <Shell server={server}>
        <p className="text-sm leading-relaxed text-foreground">{request.message}</p>
        <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={url}>
          {url}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Button
            size="sm"
            disabled={responding}
            onClick={() => {
              window.open(url, "_blank", "noopener,noreferrer")
              onAnswer(request.requestId, { action: "accept" })
            }}
          >
            Open link
            <ExternalLink data-icon="inline-end" />
          </Button>
          <Button variant="ghost" size="sm" disabled={responding} onClick={decline}>
            Decline
          </Button>
        </div>
      </Shell>
    )
  }

  return (
    <Shell server={server}>
      <p className="text-sm leading-relaxed text-foreground">{request.message}</p>

      <div className="mt-3 flex flex-col gap-3">
        {request.fields.map((field) => (
          <FieldRow
            key={field.name}
            id={`elicit-${request.requestId}-${field.name}`}
            field={field}
            value={values[field.name]}
            disabled={responding}
            onChange={(value) => setValue(field.name, value)}
          />
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          disabled={responding || !complete}
          onClick={() => onAnswer(request.requestId, {
            action: "accept",
            content: toContent(request.fields, values),
          })}
        >
          Send
        </Button>
        <Button variant="ghost" size="sm" disabled={responding} onClick={decline}>
          Decline
        </Button>
      </div>
    </Shell>
  )
}

function FieldRow({
  id,
  field,
  value,
  disabled,
  onChange,
}: {
  id: string
  field: MissionControlElicitationField
  value: string | boolean
  disabled: boolean
  onChange: (value: string | boolean) => void
}) {
  if (field.type === "boolean") {
    return (
      <Label htmlFor={id} className="items-start gap-2 font-normal">
        <Checkbox
          id={id}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(checked === true)}
        />
        <FieldText field={field} />
      </Label>
    )
  }

  if (field.type === "enum") {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}><FieldText field={field} /></Label>
        <ToggleGroup
          id={id}
          value={typeof value === "string" && value ? [value] : []}
          onValueChange={(next) => { if (next[0]) onChange(next[0]) }}
          orientation="vertical"
          variant="outline"
          size="sm"
          className="w-full items-stretch"
          aria-label={field.label}
        >
          {(field.options ?? []).map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              disabled={disabled}
              className="w-full justify-start px-3"
            >
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}><FieldText field={field} /></Label>
      <Input
        id={id}
        // The visible label carries the required marker and the description;
        // the accessible name stays the plain field label.
        aria-label={field.label}
        type={field.type === "string" ? "text" : "number"}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

function FieldText({ field }: { field: MissionControlElicitationField }) {
  return (
    <span className="min-w-0">
      {field.label}
      {field.required && <span className="ml-0.5 text-warning">*</span>}
      {field.description && (
        <span className="block text-xs font-normal text-muted-foreground">
          {field.description}
        </span>
      )}
    </span>
  )
}

function Shell({ server, children }: { server: string; children: React.ReactNode }) {
  return (
    <Alert className="border-info/40 bg-info/5">
      <Plug className="text-info" />
      <AlertTitle>{server} needs input</AlertTitle>
      <div className="col-start-2 mt-1 min-w-0">{children}</div>
    </Alert>
  )
}
