import { useId, useState } from "react"
import { evaluateCompatibility } from "@cogpit/plugin-contracts"
import type { PluginInstallPreview, PluginScope, InstalledPlugin } from "../../shared/contracts/plugins"
import type { PluginHostStatus } from "../../shared/contracts/pluginManagement"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldLabel } from "@/components/ui/field"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { PluginScopeEditor } from "./PluginScopeEditor"
import { clientRuntimeDescriptor, type RuntimePluginClient } from "./runtimeClient"

export function InstalledPluginRow({ plugin, status, client, busy, run, onPreview, onConnections, onUpdate }: {
  plugin: InstalledPlugin; status: PluginHostStatus; client: RuntimePluginClient; busy: boolean
  run: (action: () => Promise<void>) => void; onPreview: (preview: PluginInstallPreview) => void
  onConnections: (pluginId: string) => void; onUpdate: (plugin: InstalledPlugin) => void
}) {
  const id = useId()
  const [scope, setScope] = useState<PluginScope>(plugin.scope)
  const [confirmRemoval, setConfirmRemoval] = useState(false)
  const [deleteData, setDeleteData] = useState(false)
  const descriptor = clientRuntimeDescriptor()
  const compatibility = evaluateCompatibility(plugin.manifest, descriptor, status.runtime, { allowPrerelease: plugin.manifest.publisher.startsWith("dev-") })
  const change = (action: "enabled" | "pin" | "scope", values: Record<string, unknown>) => run(() => client.changeInstalled(plugin.id, action, values, status.store.revision))
  const state = plugin.lastError ? "Needs recovery" : !compatibility.compatible ? "Incompatible" : plugin.enabled ? "Enabled" : "Disabled"
  const repairSeed = plugin.lastError && status.store.availableSeeds?.find(seed => seed.manifest.id === plugin.id && seed.digest === plugin.selectedDigest)
  return <article className="flex flex-col gap-3 rounded-lg border p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex min-w-0 flex-col gap-1"><h3 className="font-medium">{plugin.manifest.name}</h3><p className="break-all text-xs text-muted-foreground">{plugin.id} · {plugin.manifest.version}</p></div>
      <Badge variant={state === "Enabled" ? "secondary" : "outline"}>{state}</Badge>
    </div>
    {plugin.lastError && <Alert variant="destructive"><AlertDescription>{plugin.lastError}</AlertDescription></Alert>}
    {!compatibility.compatible && <Alert variant="destructive"><AlertDescription>
      {compatibility.issues.map((issue) => <p key={`${issue.side}:${issue.code}:${issue.name}`}>{issue.side === "client" ? "This client" : issue.side === "host" ? status.host.name : "This package"}: {issue.name} requires {issue.required}; available {issue.actual ?? "none"}.</p>)}
      <p>Keep the saved data and update the affected app, or choose a compatible retained version below.</p>
    </AlertDescription></Alert>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => change("enabled", { enabled: !plugin.enabled })}>{plugin.enabled ? "Disable" : "Enable"}</Button>
      {plugin.manifest.permissions.connections.length > 0 && <Button size="sm" variant="outline" disabled={busy} onClick={() => onConnections(plugin.id)}>Connections</Button>}
      <Button size="sm" variant="outline" disabled={busy || plugin.pinned} onClick={() => onUpdate(plugin)}>Update from file</Button>
      {repairSeed && <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => onPreview(await client.stageSeed(plugin.id, plugin.scope)))}>Review bundled repair</Button>}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => change("pin", { pinned: !plugin.pinned })}>{plugin.pinned ? "Unpin version" : "Pin version"}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setDeleteData(false); setConfirmRemoval(true) }}>Uninstall</Button>
    </div>
    {plugin.pinned && <p className="text-xs text-muted-foreground">Unpin this version before updating or rolling back. Revoked packages remain blocked.</p>}
    <details className="text-sm"><summary className="cursor-pointer">Projects and previous versions</summary>
      <div className="flex flex-col gap-4 pt-4">
        <PluginScopeEditor value={scope} onChange={setScope} projects={status.projects} disabled={busy} />
        <Button size="sm" variant="outline" disabled={busy || JSON.stringify(scope) === JSON.stringify(plugin.scope)} onClick={() => change("scope", { scope })}>Save projects on {status.host.name}</Button>
        {plugin.versions.filter((entry) => entry.digest !== plugin.selectedDigest).map((entry) => {
          const usable = !entry.unavailableReason && evaluateCompatibility(entry.manifest, descriptor, status.runtime, { allowPrerelease: entry.manifest.publisher.startsWith("dev-") }).compatible
          return <div key={entry.digest} className="flex flex-col gap-1"><Button size="sm" variant="outline" disabled={busy || plugin.pinned || !usable}
            onClick={() => run(async () => onPreview({ ...await client.rollback(plugin.id, entry.digest, plugin.scope), operation: "rollback" }))}>Review rollback to {entry.manifest.version}</Button>
            {!usable && <p className="text-xs text-muted-foreground">{entry.unavailableReason ?? "This version is incompatible with the connected host or client."}</p>}</div>
        })}
        <p className="text-xs text-muted-foreground">Rollback keeps current settings. Disabling keeps the installation and its saved data.</p>
      </div>
    </details>
    <AlertDialog open={confirmRemoval} onOpenChange={setConfirmRemoval}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Uninstall {plugin.manifest.name}?</AlertDialogTitle><AlertDialogDescription>
        This removes the plugin from {status.host.name} for every connected client and project. Saved data is retained unless you choose deletion.
      </AlertDialogDescription></AlertDialogHeader>
        <Field orientation="horizontal"><Checkbox id={`${id}-delete`} checked={deleteData} onCheckedChange={setDeleteData} disabled={busy || status.connectionRevision === undefined} />
          <FieldLabel htmlFor={`${id}-delete`}>Delete my saved settings and connections on this host</FieldLabel></Field>
        {deleteData && <p className="text-sm text-muted-foreground">This cannot be undone. Other administrators' saved data is retained. Provider tokens and legacy backup files are not removed.</p>}
        <AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={busy} onClick={() => {
          setConfirmRemoval(false)
          run(() => client.changeInstalled(plugin.id, "uninstall", deleteData ? { deleteData: true, expectedConnectionRevision: status.connectionRevision } : { deleteData: false }, status.store.revision))
        }}>Uninstall from {status.host.name}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </article>
}
