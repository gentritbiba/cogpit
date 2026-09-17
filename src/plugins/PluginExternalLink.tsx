import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog"

interface PendingLink { url: string; finish(accepted: boolean): void }

export function usePluginExternalLink(pluginName: string) {
  const pending = useRef<PendingLink | null>(null)
  const [link, setLink] = useState<PendingLink | null>(null)
  useEffect(() => () => { pending.current?.finish(false) }, [])
  const openExternal = useCallback((value: string, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted()
    const url = new URL(value)
    if (value.length > 2048 || url.protocol !== "https:" || url.username || url.password) {
      return Promise.reject(Object.assign(new Error("Only HTTPS links without credentials are supported"), { code: "INVALID_REQUEST" }))
    }
    if (pending.current) return Promise.reject(Object.assign(new Error("A link is already awaiting review"), { code: "RATE_LIMITED" }))
    return new Promise((resolve, reject) => {
      const abort = () => next.finish(false)
      const next: PendingLink = { url: url.href, finish(accepted) {
        if (pending.current !== next) return
        pending.current = null
        signal.removeEventListener("abort", abort)
        setLink(null)
        if (accepted && !signal.aborted) resolve()
        else reject(Object.assign(new Error("Opening the link was canceled"), { code: "CANCELED" }))
      } }
      pending.current = next
      signal.addEventListener("abort", abort, { once: true })
      setLink(next)
    })
  }, [])
  const dialog = link ? <Dialog open onOpenChange={(open) => { if (!open) pending.current?.finish(false) }}>
    <DialogContent>
      <DialogTitle>Open link from {pluginName}?</DialogTitle>
      <DialogDescription>This opens a website outside Cogpit.</DialogDescription>
      <p className="max-h-48 overflow-auto break-all rounded-md bg-muted p-3 text-sm" dir="ltr">{link?.url}</p>
      <DialogFooter>
        <Button variant="outline" onClick={() => pending.current?.finish(false)}>Cancel</Button>
        <Button onClick={() => {
          if (!link || pending.current !== link) return
          window.open(link.url, "_blank", "noopener,noreferrer")
          link.finish(true)
        }}>Open website</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog> : null
  return { openExternal, dialog }
}
