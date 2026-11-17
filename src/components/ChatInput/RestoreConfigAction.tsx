import { useState } from "react"
import { RotateCcw } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { authFetch } from "@/lib/auth"

type RestoreState = { kind: "idle" } | { kind: "restoring" } | { kind: "restored" } | { kind: "failed"; message: string }

/** Puts back the backup an agent named for a config file it would not start with, once the reader confirms. */
export function RestoreConfigAction({ path, backupPath }: { path: string; backupPath: string }) {
  const [confirming, setConfirming] = useState(false)
  const [state, setState] = useState<RestoreState>({ kind: "idle" })

  const restore = async () => {
    setState({ kind: "restoring" })
    try {
      const res = await authFetch("/api/agent-check/restore-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      })
      const body = await res.json().catch(() => ({})) as { error?: string }
      setState(res.ok ? { kind: "restored" } : { kind: "failed", message: body.error ?? `HTTP ${res.status}` })
    } catch (err) {
      setState({ kind: "failed", message: err instanceof Error ? err.message : String(err) })
    }
  }

  if (state.kind === "restored") {
    return <p role="status" className="ml-2 mt-1 text-xs text-muted-foreground">Restored from the backup. Send your message again.</p>
  }

  return (
    <>
      <Button
        variant="outline"
        size="xs"
        className="ml-2"
        disabled={state.kind === "restoring"}
        onClick={() => setConfirming(true)}
      >
        <RotateCcw data-icon="inline-start" />
        Restore from backup
      </Button>
      {state.kind === "failed" && <p role="alert" className="ml-2 mt-1 text-xs text-destructive">Couldn't restore: {state.message}</p>}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Restore the config file from its backup?</AlertDialogTitle>
            <AlertDialogDescription>The backup replaces the file. Changes made since that backup are lost.</AlertDialogDescription>
          </AlertDialogHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
            <dt className="text-muted-foreground">File</dt>
            <dd className="break-all font-mono">{path}</dd>
            <dt className="text-muted-foreground">Backup</dt>
            <dd className="break-all font-mono">{backupPath}</dd>
          </dl>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
            <AlertDialogAction size="sm" onClick={() => void restore()}>Restore</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
