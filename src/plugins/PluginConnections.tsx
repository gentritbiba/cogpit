import { useEffect, useId, useRef, useState } from "react"
import { connectionResourceDependencies } from "@cogpit/plugin-contracts"
import type { PluginHostStatus } from "../../shared/contracts/pluginManagement"
import type { PluginConnectionSnapshot, PluginConnectionSummary, PluginConnectionTarget, PluginResourceSelection } from "../../shared/contracts/pluginConnections"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { RuntimePluginClient } from "./runtimeClient"

type ConnectionClient = Pick<RuntimePluginClient, "connections" | "connectionOptions" | "changeConnection">
type ChangeConnection = (connectionId: string, action: "credential" | "select" | "disconnect" | "import-legacy", values: Record<string, unknown>) => Promise<void>

function ResourceField({ connection, resourceId, target, client, disabled, save }: {
  connection: PluginConnectionSummary; resourceId: string; target: PluginConnectionTarget;
  client: ConnectionClient; disabled: boolean; save: ChangeConnection
}) {
  const id = useId()
  const resource = connection.definition.resources[resourceId]
  const selected = connection.selected[resourceId]
  const [input, setInput] = useState("")
  const [options, setOptions] = useState<PluginResourceSelection[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])
  const missingParent = connectionResourceDependencies(connection.definition, resourceId).find((parent) => !connection.selected[parent])
  const unavailable = disabled || !!missingParent || resource.scope === "project" && !target.projectId
  async function loadOptions(): Promise<void> {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setLoading(true); setError(null)
    try {
      const values = await client.connectionOptions(target, connection.id, resourceId, controller.signal)
      if (!controller.signal.aborted) setOptions(values)
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to load choices")
    } finally { if (!controller.signal.aborted) setLoading(false) }
  }
  const choices = selected && !options?.some((option) => option.id === selected.id) ? [selected, ...options ?? []] : options ?? []
  return <Field data-disabled={unavailable} data-invalid={!!error}>
    <FieldLabel htmlFor={`${id}-resource`}>{resource.label}</FieldLabel>
    <FieldDescription>{resource.scope === "project" ? "Applies to the selected project." : "Applies to all projects using this connection."}</FieldDescription>
    {selected && <p className="text-sm">Selected: {selected.label}</p>}
    {missingParent && <p className="text-sm text-muted-foreground">Choose {connection.definition.resources[missingParent].label} first.</p>}
    {resource.scope === "project" && !target.projectId && <p className="text-sm text-muted-foreground">Choose a Cogpit project above.</p>}
    {resource.options && <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" disabled={unavailable || loading} onClick={() => { void loadOptions() }}>{loading ? "Loading choices…" : options ? "Refresh choices" : "Browse choices"}</Button>
      {options && <Select items={choices.map((choice) => ({ value: choice.id, label: choice.label }))} value={selected?.id ?? null} disabled={unavailable || loading}
        onValueChange={(value) => { if (value && value !== selected?.id) void save(connection.id, "select", { resourceId, value }) }}>
        <SelectTrigger id={`${id}-resource`} aria-invalid={!!error}><SelectValue placeholder={`Choose ${resource.label}`} /></SelectTrigger>
        <SelectContent><SelectGroup>{choices.map((choice) => <SelectItem key={choice.id} value={choice.id}>{choice.label}</SelectItem>)}</SelectGroup></SelectContent>
      </Select>}
      {options?.length === 0 && <p className="text-sm text-muted-foreground">No choices were returned.</p>}
    </div>}
    {resource.input && <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void save(connection.id, "select", { resourceId, value: input.trim() }) }}>
      <Input id={resource.options ? `${id}-input` : `${id}-resource`} aria-label={`${resource.label} ${resource.input.urls ? "URL or ID" : "ID"}`} value={input}
        onChange={(event) => setInput(event.target.value)} maxLength={2048} disabled={unavailable} autoComplete="off" spellCheck={false}
        placeholder={resource.input.urls ? "Paste a URL or ID" : "Enter an ID"} />
      <Button type="submit" size="sm" variant="outline" disabled={unavailable || !input.trim()}>Validate and select</Button>
    </form>}
    {selected && <Button type="button" size="sm" variant="ghost" disabled={unavailable} onClick={() => { void save(connection.id, "select", { resourceId, value: null }) }}>Clear {resource.label}</Button>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </Field>
}

function ConnectionForm({ connection, target, client, disabled, save }: {
  connection: PluginConnectionSummary; target: PluginConnectionTarget; client: ConnectionClient;
  disabled: boolean; save: ChangeConnection
}) {
  const id = useId()
  const [secret, setSecret] = useState("")
  const [replaceExisting, setReplaceExisting] = useState(false)
  return <section className="flex flex-col gap-4 rounded-lg border p-4" aria-label={connection.label}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{connection.label}</h3><Badge variant="outline">{connection.status === "disconnected" ? "Needs connection" : connection.readOnly ? "Configured by host" : "Connected"}</Badge></div>
    <p className="text-sm text-muted-foreground">Cogpit keeps this credential on the selected host. Plugin code cannot read it.</p>
    <p className="break-all text-xs text-muted-foreground">Credential destinations: {[...new Set(Object.values(connection.definition.operations).map((operation) => operation.origin))].join(", ")}</p>
    {connection.legacyImportAvailable && <div className="flex flex-col gap-3 rounded-md bg-muted p-3">
      <p className="text-sm">An existing host connection has saved settings available to import.</p>
      {connection.status === "connected" && !connection.readOnly && <Field orientation="horizontal"><Checkbox id={`${id}-replace`} checked={replaceExisting} onCheckedChange={setReplaceExisting} disabled={disabled} />
        <FieldLabel htmlFor={`${id}-replace`}>Allow replacing my current connection with these saved settings</FieldLabel></Field>}
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => { void save(connection.id, "import-legacy", { replaceExisting }) }}>Import saved host settings</Button>
    </div>}
    {connection.readOnly ? <p className="text-sm">The host environment supplies this credential. Change it on the host.</p>
      : <form onSubmit={(event) => { event.preventDefault(); const value = secret.trim(); setSecret(""); void save(connection.id, "credential", { secret: value }) }}>
        <FieldGroup><Field data-disabled={disabled}><FieldLabel htmlFor={`${id}-secret`}>{connection.definition.secret.label}</FieldLabel>
          <Input id={`${id}-secret`} type="password" autoComplete="off" spellCheck={false} maxLength={4096} disabled={disabled} value={secret} onChange={(event) => setSecret(event.target.value)} />
        </Field><div className="flex flex-wrap gap-2"><Button type="submit" size="sm" disabled={disabled || !secret.trim()}>{connection.status === "disconnected" ? "Validate and connect" : "Replace credential"}</Button>
          {connection.status !== "disconnected" && <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => { void save(connection.id, "disconnect", {}) }}>Disconnect</Button>}
        </div></FieldGroup>
      </form>}
    {connection.status !== "disconnected" && <FieldGroup>{Object.keys(connection.definition.resources).map((resourceId) => <ResourceField key={resourceId}
      connection={connection} resourceId={resourceId} target={target} client={client} disabled={disabled} save={save} />)}</FieldGroup>}
  </section>
}

function ConnectionsForProject({ client, target }: { client: ConnectionClient; target: PluginConnectionTarget }) {
  const [snapshot, setSnapshot] = useState<PluginConnectionSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const lifetime = useRef<AbortController | null>(null)
  const mutation = useRef(false)
  const pluginId = target.pluginId, projectId = target.projectId
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    void client.connections({ pluginId, projectId }, controller.signal).then((value) => {
      if (!controller.signal.aborted) setSnapshot(value)
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to load connections")
    })
    return () => { controller.abort(); lifetime.current = null }
  }, [client, pluginId, projectId])
  async function save(connectionId: string, action: "credential" | "select" | "disconnect" | "import-legacy", values: Record<string, unknown>): Promise<void> {
    if (!snapshot || mutation.current || !lifetime.current || lifetime.current.signal.aborted) return
    mutation.current = true
    const signal = lifetime.current.signal
    setBusy(true); setError(null)
    try {
      const next = await client.changeConnection(target, connectionId, action, values, snapshot.revision, signal)
      if (!signal.aborted) setSnapshot(next)
    } catch (failure) {
      if (!signal.aborted) setError(failure instanceof Error ? failure.message : "Connection change failed")
    } finally { mutation.current = false; if (!signal.aborted) setBusy(false) }
  }
  return <div className="flex flex-col gap-4">
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {!snapshot && !error && <p role="status" className="text-sm text-muted-foreground">Loading connections…</p>}
    {snapshot?.connections.map((connection) => <ConnectionForm key={`${connection.id}:${snapshot.revision}`} connection={connection} target={target} client={client} disabled={busy} save={save} />)}
    {snapshot?.connections.length === 0 && <p className="text-sm text-muted-foreground">This plugin does not use provider connections.</p>}
  </div>
}

export function PluginConnections({ client, status, pluginId, initialProjectId }: {
  client: ConnectionClient; status: PluginHostStatus; pluginId: string; initialProjectId: string | null
}) {
  const [projectId, setProjectId] = useState(initialProjectId)
  const id = useId()
  const choices = [{ value: "", label: "Host connections only" }, ...status.projects.map((project) => ({ value: project.id, label: project.name }))]
  return <div className="flex flex-col gap-4">
    <Field><FieldLabel htmlFor={id}>Project settings</FieldLabel>
      <Select items={choices} value={projectId ?? ""} onValueChange={(value) => setProjectId(value || null)}>
        <SelectTrigger id={id}><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup>{choices.map((choice) => <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>)}</SelectGroup></SelectContent>
      </Select><FieldDescription>Connection credentials belong to {status.host.name}. Project resources stay within the project you choose.</FieldDescription>
    </Field>
    <ConnectionsForProject key={`${pluginId}:${projectId ?? "host"}:${status.connectionRevision ?? 0}`} client={client} target={{ pluginId, projectId }} />
  </div>
}
