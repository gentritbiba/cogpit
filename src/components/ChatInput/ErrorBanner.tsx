import { useState } from "react"
import { Copy, Check, AlertCircle, ExternalLink } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { descriptorFor, type AgentKind } from "@/lib/agents"
import { agentNotInstalledIn, agentSignedOutTitle, classifyAgentFailure } from "../../../shared/session/agentFailures"

/**
 * Inline send error shown under the composer. The preview is a single
 * truncated line; clicking it opens the full verbose error (including the
 * CLI's captured stderr) in a copyable dialog so failures can actually be
 * diagnosed instead of just reading "Claude Code process exited with code 1".
 */
export function ErrorBanner({ error, agentKind }: { error: string; agentKind: AgentKind }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  // A missing login reads the same for every agent, whatever words its CLI used.
  const signedOut = classifyAgentFailure(error).reason === "not_signed_in"
  const firstLine = signedOut ? agentSignedOutTitle(agentKind) : error.split("\n")[0]
  const hasMore = error.includes("\n") || error !== firstLine
  const missing = agentNotInstalledIn(error)
  const installPage = missing ? descriptorFor(missing).cli.install?.page : null

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
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        title="Click to view the full error"
        className="motion-enter mt-1 w-full justify-start text-destructive"
      >
        <AlertCircle data-icon="inline-start" />
        <span className="truncate">{firstLine}</span>
        {hasMore && <span className="shrink-0 opacity-60">(details)</span>}
      </Button>
      {installPage && (
        <Button
          variant="outline"
          size="xs"
          className="ml-2"
          render={<a href={installPage} target="_blank" rel="noopener noreferrer" />}
          nativeButton={false}
        >
          <ExternalLink data-icon="inline-start" />
          How to install
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertCircle className="size-4" />
              Error details
            </DialogTitle>
            <DialogDescription>
              The full output from the failed request, including the underlying
              process stderr.
            </DialogDescription>
          </DialogHeader>

          <pre className="max-h-[50vh] select-text overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-mono text-xs text-destructive">
            {error}
          </pre>

          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopy}
            >
              {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
