import type { PluginInstallPreview } from "../../shared/contracts/plugins"
import type { PluginManifest } from "@cogpit/plugin-contracts"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

const integrationNames: Readonly<Record<string, string>> = { github: "GitHub", vercel: "Vercel", cloudflare: "Cloudflare" }
const integrationLabels: Readonly<Record<string, string>> = {
  actions: "workflow runs", actionJobs: "workflow jobs and steps", pulls: "pull requests", pullFiles: "pull request files",
  issues: "issues", deployments: "deployments", buildLogs: "build logs", workspace: "Worker configuration and account", version: "version details",
}

function accessLines(manifest: PluginManifest): string[] {
  const permissions = manifest.permissions
  return [
    ...permissions.context.map(() => "Read the selected project's name and plugin identifier"),
    ...permissions.composer.map(() => "Append text to your draft message"),
    ...permissions.navigation.map((kind) => kind === "external" ? "Ask Cogpit to open HTTPS links" : "Open permitted sessions"),
    ...(permissions.storage ? [`Store up to ${permissions.storage.quotaKiB} KiB of ${permissions.storage.scope} settings`] : []),
    ...permissions.connections.flatMap((connection) => connection.operations.map((operation) => `Use connection ${connection.id}: ${operation}`)),
    ...permissions.integrations.flatMap((integration) => integration.operations.map((operation) => operation === "pullSessions"
      ? "Read related Cogpit sessions for the selected GitHub repository"
      : `Read ${integrationNames[integration.id]} ${integrationLabels[operation]} using this host's signed-in CLI`)),
  ]
}

export function PluginInstallReview({ preview }: { preview: PluginInstallPreview }) {
  const lines = accessLines(preview.manifest)
  const previous = preview.previousManifest ? accessLines(preview.previousManifest) : null
  const added = previous ? lines.filter((line) => !previous.includes(line)) : []
  const removed = previous ? previous.filter((line) => !lines.includes(line)) : []
  const changedDefinitions = preview.previousConnectionDefinitions ? preview.connectionDefinitions.filter((definition) => {
    const old = preview.previousConnectionDefinitions?.find((entry) => entry.id === definition.id)
    return !old || JSON.stringify(old) !== JSON.stringify(definition)
  }) : []
  return <div className="flex flex-col gap-3 text-sm">
    {preview.oldVersion && <Alert><AlertTitle>{preview.operation === "rollback" ? "Rollback keeps current settings" : "Update on this host"}</AlertTitle><AlertDescription>
      Saved settings and connections are retained. This version replaces {preview.oldVersion} in every enabled project and connected client. A failed trial leaves the current version selected.
    </AlertDescription></Alert>}
    {previous && <div className="flex flex-col gap-2"><h3 className="font-medium">Access changes</h3>
      {added.length === 0 && removed.length === 0 && changedDefinitions.length === 0 && <p>No changes to requested access or connection definitions.</p>}
      {added.map((line) => <p key={`add:${line}`}>Added: {line}</p>)}
      {removed.map((line) => <p key={`remove:${line}`}>Removed: {line}</p>)}
      {changedDefinitions.map((definition) => <p key={definition.id}>Changed connection: {definition.label}. Review its destinations and access below.</p>)}
    </div>}
    {preview.oldVersion && !previous && <Alert><AlertDescription>This host does not report previous permissions. Review all requested access before continuing.</AlertDescription></Alert>}
    <h3 className="font-medium">Requested access</h3>
    {lines.length ? <ul className="ml-4 flex list-disc flex-col gap-1">{lines.map((line) => <li key={line}>{line}</li>)}</ul> : <p className="text-muted-foreground">No project, connection, storage, or composer access requested.</p>}
    {preview.connectionDefinitions.map((definition) => <div key={definition.id} className="flex flex-col gap-1">
      <p className="font-medium">{definition.label}</p>
      <p>Access to {Object.values(definition.resources).map((resource) => resource.label).join(", ") || "the connected account"}.</p>
      <p className="break-all text-muted-foreground">Credential destinations: {[...new Set(Object.values(definition.operations).map((operation) => operation.origin))].join(", ")}</p>
    </div>)}
    {!!preview.incompatibleClients?.length && <Alert><AlertTitle>Some connected clients cannot run this version</AlertTitle><AlertDescription>
      {preview.incompatibleClients.join(", ")}. Their plugin panels will be unavailable until those clients are updated. Offline clients are checked when they reconnect.
    </AlertDescription></Alert>}
    <p className="break-all text-xs text-muted-foreground">SHA-256: {preview.digest}</p>
  </div>
}
