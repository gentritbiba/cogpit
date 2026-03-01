import { useState, useEffect } from "react"
import { X, Download, ArrowUpCircle } from "lucide-react"

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

  // AppImage: update downloaded, show restart prompt
  if (downloadedInfo && !dismissed) {
    return (
      <div className="flex items-center gap-3 bg-emerald-500/10 border-b border-emerald-500/20 px-4 py-2 text-sm">
        <ArrowUpCircle className="size-4 text-emerald-400 shrink-0" />
        <span className="text-emerald-300">
          Cogpit v{downloadedInfo.version} is ready — restart to apply
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setDismissed(true)}
          className="text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Dismiss"
        >
          <X className="size-4" />
        </button>
      </div>
    )
  }

  // macOS / Linux system pkg: update available notification
  if (updateInfo && !dismissed) {
    return (
      <div className="flex items-center gap-3 bg-blue-500/10 border-b border-blue-500/20 px-4 py-2 text-sm">
        <ArrowUpCircle className="size-4 text-blue-400 shrink-0" />
        <span className="text-blue-300">
          Cogpit v{updateInfo.version} is available
        </span>
        <div className="flex-1" />
        {updateInfo.platform === "mac" ? (
          <a
            href={updateInfo.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-md bg-blue-500/20 px-2.5 py-1 text-xs font-medium text-blue-300 hover:bg-blue-500/30 transition-colors"
          >
            <Download className="size-3" />
            Download
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">
            Update via your package manager
          </span>
        )}
        <button
          onClick={() => {
            setDismissed(true)
            window.electronUpdater?.dismissVersion(updateInfo.version)
          }}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap"
        >
          Don't show again
        </button>
      </div>
    )
  }

  return null
}
