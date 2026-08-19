import { useState, useEffect } from "react"
import { X, Download, ArrowUpCircle } from "lucide-react"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

interface UpdateInfo {
  version: string
  url: string
  platform: string // "mac" | "linux-pkg"
}

interface DownloadedInfo {
  version: string
}

export function UpdateBanner() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [downloadedInfo, setDownloadedInfo] = useState<DownloadedInfo | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const api = window.electronUpdater
    if (!api) return

    api.onUpdateAvailable((info) => {
      setUpdateInfo(info)
    })

    api.onUpdateDownloaded((info) => {
      setDownloadedInfo(info)
    })
  }, [])

  // Windows / AppImage: update downloaded, show restart prompt
  if (downloadedInfo && !dismissed) {
    return (
      <Alert className="grid-cols-[auto_minmax(0,1fr)_auto] rounded-none border-x-0 border-t-0 border-success/30 bg-success/10 px-4 py-2 pr-4 text-success has-data-[slot=alert-action]:pr-4">
        <ArrowUpCircle />
        <AlertTitle>Cogpit v{downloadedInfo.version} is ready</AlertTitle>
        <AlertDescription className="text-success/80">Restart to apply the update.</AlertDescription>
        <AlertAction className="static col-start-3 row-span-2 row-start-1 self-center">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss update"
          >
            <X data-icon="inline-start" />
          </Button>
        </AlertAction>
      </Alert>
    )
  }

  // macOS / Linux system pkg: update available notification
  if (updateInfo && !dismissed) {
    return (
      <Alert className="grid-cols-[auto_minmax(0,1fr)_auto] rounded-none border-x-0 border-t-0 border-info/30 bg-info/10 px-4 py-2 pr-4 text-info has-data-[slot=alert-action]:pr-4">
        <ArrowUpCircle />
        <AlertTitle>Cogpit v{updateInfo.version} is available</AlertTitle>
        {updateInfo.platform !== "mac" && (
          <AlertDescription>Update through your package manager.</AlertDescription>
        )}
        <AlertAction className="static col-start-3 row-span-2 row-start-1 flex items-center gap-2 self-center">
          {updateInfo.platform === "mac" && (
            <Button
              variant="outline"
              size="xs"
              render={<a href={updateInfo.url} target="_blank" rel="noopener noreferrer" />}
              nativeButton={false}
            >
              <Download data-icon="inline-start" />
              Download
            </Button>
          )}
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setDismissed(true)
              window.electronUpdater?.dismissVersion(updateInfo.version)
            }}
            className="whitespace-nowrap text-muted-foreground"
          >
            Don't show again
          </Button>
        </AlertAction>
      </Alert>
    )
  }

  return null
}
