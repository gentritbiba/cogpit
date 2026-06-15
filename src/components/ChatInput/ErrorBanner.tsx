import { useState } from "react"
import { Copy, Check, AlertCircle } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"

/**
 * Inline send error shown under the composer. The preview is a single
 * truncated line; clicking it opens the full verbose error (including the
 * CLI's captured stderr) in a copyable dialog so failures can actually be
 * diagnosed instead of just reading "Claude Code process exited with code 1".
 */
export function ErrorBanner({ error }: { error: string }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const firstLine = error.split("\n")[0]
  const hasMore = error.includes("\n") || error.length > firstLine.length

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(error)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable — ignore
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Click to view the full error"
        className="mt-1 flex w-full items-center gap-1 text-left text-[10px] text-red-400 hover:text-red-300 hover:underline"
      >
        <AlertCircle className="size-3 shrink-0" />
        <span className="truncate">{firstLine}</span>
        {hasMore && <span className="shrink-0 opacity-60">(details)</span>}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-400">
              <AlertCircle className="size-4" />
              Error details
            </DialogTitle>
            <DialogDescription>
              The full output from the failed request, including the underlying
              process stderr.
            </DialogDescription>
          </DialogHeader>

          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-elevation-0 p-3 font-mono text-xs text-red-300 select-text">
            {error}
          </pre>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-elevation-2"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
