import { useState, useEffect } from "react"
import { X, Download, ArrowUpCircle, RotateCw, TriangleAlert } from "lucide-react"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

const ROW = "grid-cols-[auto_minmax(0,1fr)_auto] rounded-none border-x-0 border-t-0 px-4 py-2 pr-4 has-data-[slot=alert-action]:pr-4"
const ACTIONS = "static col-start-3 row-span-2 row-start-1 flex items-center gap-2 self-center"

export function UpdateBanner() {
  const [update, setUpdate] = useState<ElectronUpdateState>({ status: "idle" })
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)

  useEffect(() => {
    const api = window.electronUpdater
    if (!api) return
    let live = true
    void api.getState().then((state) => { if (live) setUpdate(state) })
    const unsubscribe = api.onState((state) => {
      setUpdate(state)
      setRestarting(false)
    })
    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  if (update.status === "idle" || dismissed === `${update.status}:${update.version}`) return null
  const dismiss = () => setDismissed(`${update.status}:${update.version}`)
  const close = (
    <Button variant="ghost" size="icon-xs" onClick={dismiss} aria-label="Dismiss update">
      <X data-icon="inline-start" />
    </Button>
  )

  if (update.status === "ready") {
    return (
      <Alert className={`${ROW} border-success/30 bg-success/10 text-success`}>
        <ArrowUpCircle />
        <AlertTitle>Cogpit v{update.version} is ready</AlertTitle>
        <AlertDescription className="text-success/80">
          {update.asksForPassword
            ? "Restart and enter your password to install it."
            : "Restart to finish updating, or it installs the next time you quit."}
        </AlertDescription>
        <AlertAction className={ACTIONS}>
          <Button
            variant="outline"
            size="xs"
            disabled={restarting}
            onClick={() => {
              setRestarting(true)
              void window.electronUpdater?.install()
            }}
          >
            <RotateCw data-icon="inline-start" />
            Restart now
          </Button>
          {close}
        </AlertAction>
      </Alert>
    )
  }

  const download = (url: string) => (
    <Button
      variant="outline"
      size="xs"
      render={<a href={url} target="_blank" rel="noopener noreferrer" />}
      nativeButton={false}
    >
      <Download data-icon="inline-start" />
      Download
    </Button>
  )

  if (update.status === "failed") {
    return (
      <Alert className={`${ROW} border-destructive/30 bg-destructive/10 text-destructive`}>
        <TriangleAlert />
        <AlertTitle>Cogpit v{update.version} could not be installed</AlertTitle>
        <AlertDescription className="text-destructive/80">{update.message}</AlertDescription>
        <AlertAction className={ACTIONS}>
          {download(update.url)}
          {close}
        </AlertAction>
      </Alert>
    )
  }

  return (
    <Alert className={`${ROW} border-info/30 bg-info/10 text-info`}>
      <ArrowUpCircle />
      <AlertTitle>Cogpit v{update.version} is available</AlertTitle>
      {update.via === "package-manager" && (
        <AlertDescription>Update through your package manager.</AlertDescription>
      )}
      <AlertAction className={ACTIONS}>
        {update.via === "download" && download(update.url)}
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            dismiss()
            window.electronUpdater?.dismissVersion(update.version)
          }}
          className="whitespace-nowrap text-muted-foreground"
        >
          Don't show again
        </Button>
      </AlertAction>
    </Alert>
  )
}
