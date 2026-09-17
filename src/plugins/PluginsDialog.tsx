import { useEffect, useId, useRef, useState } from "react"
import { Puzzle, RefreshCw } from "lucide-react"
import type { PluginInstallPreview, PluginScope, InstalledPlugin } from "../../shared/contracts/plugins"
import { compareVersions } from "../../shared/versions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PluginScopeEditor } from "./PluginScopeEditor"
import { PluginPublisherForm } from "./PluginPublisherForm"
import { PluginInstallTrial } from "./PluginInstallTrial"
import { PluginConnections } from "./PluginConnections"
import { InstalledPluginRow } from "./InstalledPluginRow"
import { PluginInstallReview } from "./PluginInstallReview"
import { setBrowserSafeMode, useBrowserSafeMode } from "./browserSafeMode"
import type { RuntimePluginClient, RuntimePluginState } from "./runtimeClient"
import { useRuntimeProject } from "./useRuntimeProject"

export function PluginsDialog({ client, state, currentPath, onClose, initialPluginId }: {
  client: RuntimePluginClient; state: RuntimePluginState; currentPath: string | null; onClose: () => void; initialPluginId?: string
}) {
  const id = useId()
  const status = state.status
  const localSafeMode = useBrowserSafeMode()
  const safeMode = status?.safeMode || localSafeMode
  const { project: currentProject, resolving: resolvingProject } = useRuntimeProject({ client, status, activation: state.activation, projectPath: currentPath })
  const [chosenScope, setScope] = useState<PluginScope | null>(null)
  const scope: PluginScope = chosenScope ?? { type: "projects", projectIds: currentProject ? [currentProject.id] : [] }
  const [preview, setPreview] = useState<PluginInstallPreview | null>(null)
  const [reviewOwner, setReviewOwner] = useState({ activation: "", hostName: "" })
  const [trial, setTrial] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [tab, setTab] = useState<string>("installed")
  const [updateTarget, setUpdateTarget] = useState<InstalledPlugin | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [connectionsId, setConnectionsId] = useState(initialPluginId)
  const connectionPlugin = status?.store.plugins.find((plugin) => plugin.id === connectionsId)
  const lock = useRef(false)
  const liveReview = !!status?.store.available && reviewOwner.activation === state.activation
  function showPreview(candidate: PluginInstallPreview): void {
    setReviewOwner({ activation: state.activation, hostName: status?.host.name ?? "the selected host" })
    setPreview(candidate)
  }
  useEffect(() => {
    if (!preview || (liveReview && !(safeMode && trial))) return
    setTrial(false); setPreview(null)
    setError("The host connection or plugin execution state changed. Review the package again before installing.")
    void client.cancel(preview).catch(() => {})
  }, [client, preview, liveReview, safeMode, trial])
  useEffect(() => () => { if (preview) void client.cancel(preview).catch(() => {}) }, [client, preview])
  async function run(action: () => Promise<void>): Promise<void> {
    if (lock.current) return
    lock.current = true
    setBusy(true); setError(null); setNotice(null)
    try { await action() }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Plugin action failed") }
    finally { lock.current = false; setBusy(false) }
  }
  function clearPreview(): void {
    const candidate = preview
    setTrial(false); setPreview(null)
    if (candidate) void client.cancel(candidate).catch(() => {})
  }
  async function reviewFile(): Promise<void> {
    if (!file || (!updateTarget && !chosenScope && resolvingProject)) return
    const candidate = await client.stage(file, updateTarget?.scope ?? scope)
    if (updateTarget && candidate.manifest.id !== updateTarget.id) {
      await client.cancel(candidate)
      throw new Error(`Choose a package for ${updateTarget.manifest.name} (${updateTarget.id}).`)
    }
    showPreview(candidate)
  }
  const disabled = busy || trial || !status?.store.available
  return <Dialog open onOpenChange={(open) => { if (!open && !busy && !trial) { clearPreview(); onClose() } }}>
    <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-2xl" showCloseButton={!busy && !trial}>
      <DialogHeader><DialogTitle>Plugins</DialogTitle><DialogDescription>
        {status ? `Installed on ${status.host.name}. Changes apply to every client connected to this host.` : "Connecting to the selected host…"}
      </DialogDescription></DialogHeader>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
        {(state.error || error || status?.store.error) && <Alert variant="destructive"><AlertTitle>{status?.store.available && !error && !state.error ? "Plugin setup needs attention" : "Plugin action unavailable"}</AlertTitle><AlertDescription>{error ?? state.error ?? status?.store.error}</AlertDescription></Alert>}
        {notice && <Alert><AlertDescription>{notice}</AlertDescription></Alert>}
        {safeMode && <Alert><AlertTitle>Plugin safe mode</AlertTitle><AlertDescription>Plugin panels are stopped. You can disable or uninstall plugins here.{status?.safeMode && " The host owner must restart Cogpit without COGPIT_DISABLE_PLUGINS=1 to resume plugins on this host."}</AlertDescription></Alert>}
        <Button size="sm" variant="outline" disabled={busy || trial || status?.safeMode} onClick={() => setBrowserSafeMode(!localSafeMode)}>{localSafeMode ? "Resume plugins in this browser" : "Pause plugins in this browser"}</Button>
        {status?.store.recoveryCode && <p className="text-sm text-muted-foreground">{status.store.recoveryCode === "STORE_LOCKED" ? "Close the other Cogpit process using this data directory, then restart this host." : status.store.recoveryCode === "STORE_VERSION" ? "Open this host with the Cogpit version that last used its plugin store, or a newer compatible version." : "Keep the plugin data directory intact. Restart with plugin safe mode enabled and check the host log before restoring a verified backup."}</p>}
        {!status && <Button variant="outline" disabled={busy} onClick={() => { void run(() => client.refresh()) }}><RefreshCw data-icon="inline-start" />Retry connection</Button>}
        {status && connectionPlugin && !preview && <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-medium">{connectionPlugin.manifest.name} connections</h2><Button variant="outline" size="sm" onClick={() => setConnectionsId(undefined)}>Back to installed</Button></div>
          <PluginConnections key={`${connectionPlugin.id}:${status.store.revision}`} client={client} status={status} pluginId={connectionPlugin.id} initialProjectId={currentProject?.id ?? null} />
        </div>}
        {status && !connectionPlugin && !preview && <Tabs value={tab} onValueChange={(value) => { setTab(String(value)); setUpdateTarget(null); setFile(null) }}>
          <TabsList className="h-auto flex-wrap"><TabsTrigger value="installed">Installed</TabsTrigger><TabsTrigger value="browse">Browse</TabsTrigger><TabsTrigger value="install">Install from file</TabsTrigger><TabsTrigger value="publishers">Publishers</TabsTrigger></TabsList>
          <TabsContent value="installed"><div className="flex flex-col gap-3 pt-4">
            {status.store.plugins.length ? status.store.plugins.map((plugin) => <InstalledPluginRow key={`${plugin.id}:${status.store.revision}`} plugin={plugin} status={status} client={client} busy={disabled} run={(action) => { void run(action) }} onPreview={showPreview} onConnections={setConnectionsId} onUpdate={(plugin) => { setUpdateTarget(plugin); setFile(null); setTab("install") }} />)
              : <Empty><EmptyHeader><EmptyMedia variant="icon"><Puzzle /></EmptyMedia><EmptyTitle>No installed plugins</EmptyTitle><EmptyDescription>Browse available plugins or install a signed package to add panels to this host.</EmptyDescription></EmptyHeader></Empty>}
          </div></TabsContent>
          <TabsContent value="browse"><div className="flex flex-col gap-4 pt-4">
            <p className="text-sm text-muted-foreground">These optional plugins are available with this Cogpit release. Choose which ones to install on {status.host.name}.</p>
            <PluginScopeEditor value={scope} onChange={setScope} projects={status.projects} disabled={disabled} />
            {(status.store.availableSeeds ?? []).map((seed) => {
              const installed = status.store.plugins.find((plugin) => plugin.id === seed.manifest.id)
              const updateAvailable = installed && compareVersions(seed.manifest.version, installed.manifest.version) === 1
              return <article key={seed.manifest.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
              <div><h3 className="font-medium">{seed.manifest.name}</h3><p className="text-xs text-muted-foreground">{seed.manifest.version} · {seed.manifest.publisher}</p></div>
              {updateAvailable ? <Button size="sm" disabled={disabled || installed.pinned} onClick={() => { void run(async () => showPreview(await client.stageSeed(seed.manifest.id, installed.scope))) }}>{installed.pinned ? "Pinned to installed version" : "Review update"}</Button>
                : installed ? <Badge variant="outline">Installed</Badge>
                : <Button size="sm" disabled={disabled || (!chosenScope && resolvingProject)} onClick={() => { void run(async () => showPreview(await client.stageSeed(seed.manifest.id, scope))) }}>Review installation</Button>}
            </article>})}
            {!status.store.availableSeeds?.length && <p className="text-sm text-muted-foreground">This host has no bundled plugin packages. You can install a signed package from a file.</p>}
          </div></TabsContent>
          <TabsContent value="install"><form className="pt-4" onSubmit={(event) => { event.preventDefault(); void run(reviewFile) }}>
            <FieldGroup>{updateTarget && <p className="text-sm">Update {updateTarget.manifest.name} from {updateTarget.manifest.version}. Existing project access is retained.</p>}<Field><FieldLabel htmlFor={`${id}-package`}>Signed plugin package</FieldLabel><Input id={`${id}-package`} type="file" accept=".cogpit-plugin" disabled={disabled} required onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></Field>
              {!updateTarget && <PluginScopeEditor value={scope} onChange={setScope} projects={status.projects} disabled={disabled} />}
              <Button type="submit" disabled={disabled || !file || (!updateTarget && !chosenScope && resolvingProject)}>Review {updateTarget ? "update" : "installation"} on {status.host.name}</Button>
            </FieldGroup>
          </form></TabsContent>
          <TabsContent value="publishers"><div className="flex flex-col gap-4 pt-4">
            {status.store.publishers.map((publisher) => <div key={publisher.id} className="flex flex-col gap-1"><p className="text-sm font-medium">{publisher.label} <Badge variant="outline">{publisher.kind}</Badge></p><p className="break-all text-xs text-muted-foreground">{publisher.id} · {publisher.fingerprint}</p></div>)}
            <details><summary className="cursor-pointer text-sm">Trust a development publisher</summary><div className="pt-4"><PluginPublisherForm client={client} busy={disabled} run={(action) => { void run(action) }} /></div></details>
          </div></TabsContent>
        </Tabs>}
        {preview && <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2"><h2 className="text-lg font-medium">{preview.manifest.name} {preview.manifest.version}</h2><p className="text-sm text-muted-foreground">{preview.oldVersion ? `Replaces ${preview.oldVersion}` : "New installation"} on {reviewOwner.hostName}</p><Badge variant="outline">{preview.publisherKind === "development" ? "Development publisher" : "Official publisher"}</Badge></div>
          <PluginInstallReview preview={preview} />
          <p className="text-sm">Available in: {preview.scope.type === "all" ? "all projects on this host, including new projects" : preview.scope.projectIds.length ? preview.scope.projectIds.map((projectId) => status?.projects.find((project) => project.id === projectId)?.name ?? "unavailable project").join(", ") : "no projects until you choose one"}.</p>
          {!preview.compatibility.compatible && <Alert variant="destructive"><AlertTitle>Incompatible version</AlertTitle><AlertDescription><ul className="flex flex-col gap-1">{preview.compatibility.issues.map((issue) => <li key={`${issue.side}:${issue.code}:${issue.name}`}>{issue.side}: {issue.name} requires {issue.required}; available {issue.actual ?? "none"}.</li>)}</ul></AlertDescription></Alert>}
          {preview.compatibility.unavailableOptional.length > 0 && <Alert><AlertDescription>Some optional features are unavailable: {preview.compatibility.unavailableOptional.map((issue) => issue.name).join(", ")}.</AlertDescription></Alert>}
          {trial && liveReview && !safeMode ? <><PluginInstallTrial client={client} preview={preview} activation={state.activation} onComplete={() => { setTrial(false); setPreview(null); setNotice(`${preview.manifest.name} ${preview.manifest.version} is ${preview.operation === "rollback" ? "restored" : preview.oldVersion ? "updated" : "installed"} on ${reviewOwner.hostName}.`); setTab("installed"); setUpdateTarget(null) }}
            onError={(failure) => { setError(failure.message); clearPreview() }} /><Button variant="outline" onClick={clearPreview}>Cancel {preview.operation === "rollback" ? "rollback" : preview.oldVersion ? "update" : "installation"}</Button></>
            : <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" disabled={busy} onClick={clearPreview}>Cancel</Button><Button disabled={disabled || !liveReview || !preview.compatibility.compatible || safeMode} onClick={() => { setError(null); setTrial(true) }}>{preview.operation === "rollback" ? "Roll back" : preview.oldVersion ? "Update" : "Install"} on {reviewOwner.hostName}</Button></div>}
        </div>}
      </div>
    </DialogContent>
  </Dialog>
}
