import { useState } from "react"
import { Copy, ExternalLink, Globe, RefreshCw, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ConfirmActionDialog } from "@/components/shared/ConfirmActionDialog"
import { usePublication } from "@/components/timeline/cogpit-blocks/view/storedView"
import { cn, copyToClipboard } from "@/lib/utils"
import { publishFailure, useViewPublishing, type ViewPublisher } from "./useViewPublishing"

type Pending = { kind: "publish"; publisher: ViewPublisher } | { kind: "unpublish"; publisher: ViewPublisher } | null

/** Copies `url`, saying `copied`, or only `otherwise` when the clipboard refuses. */
async function copyLink(url: string, copied: string, otherwise: string): Promise<void> {
  toast.success(await copyToClipboard(url) ? copied : otherwise, { description: url })
}

/**
 * Publishing for one stored view: publish the version shown through an
 * installed host plugin, then copy, update or take down its one public link.
 * Hidden when nothing publishes views and this one is not published.
 */
export function PublishViewMenu({ id, title, version, size = "icon-xs" }: { id: string; title: string; version: number; size?: "icon-xs" | "icon-sm" }) {
  const publication = usePublication(id)
  const { publishers, publish, unpublish, publisherOf } = useViewPublishing()
  const [pending, setPending] = useState<Pending>(null)
  const [updating, setUpdating] = useState(false)
  if (!publication && publishers.length === 0) return null

  const owner = publisherOf(publication)
  const run = async (action: () => Promise<void>, host: string): Promise<string | null> => {
    try {
      await action()
      setPending(null)
      return null
    } catch (error) {
      return publishFailure(error, host)
    }
  }

  const update = async () => {
    if (!owner) return
    setUpdating(true)
    try {
      const next = await publish(owner, id, version)
      toast.success(`Updated the public page to v${version}`, { description: next.url })
    } catch (error) {
      toast.error(publishFailure(error, owner.manifest.contributes.publish.title))
    } finally {
      setUpdating(false)
    }
  }

  const label = publication ? `Published · v${publication.version}` : "Publish"
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={(
            <Button
              type="button" variant="ghost" size={size} aria-label={label} title={label} data-testid="view-publish"
              className={cn("text-muted-foreground", publication && "text-primary")}
              disabled={updating}
            />
          )}
        >
          <Globe data-icon="icon" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          {publication ? (
            <>
              <DropdownMenuGroup>
                <DropdownMenuLabel className="truncate font-normal text-muted-foreground" title={publication.url}>
                  Public at {publication.title}, v{publication.version}
                </DropdownMenuLabel>
                <DropdownMenuItem onClick={() => void copyLink(publication.url, "Link copied", "The page's link")}>
                  <Copy data-icon="inline-start" />
                  Copy link
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => window.open(publication.url, "_blank", "noopener,noreferrer")}>
                  <ExternalLink data-icon="inline-start" />
                  Open page
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              {owner ? (
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => void update()}>
                    <RefreshCw data-icon="inline-start" />
                    {version === publication.version ? `Publish v${version} again` : `Update to v${version}`}
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={() => setPending({ kind: "unpublish", publisher: owner })}>
                    <Trash2 data-icon="inline-start" />
                    Take down
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              ) : (
                <p className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">
                  {publication.title} is not installed, so the page cannot be updated or taken down here.
                </p>
              )}
            </>
          ) : (
            <DropdownMenuGroup>
              {publishers.map((publisher) => (
                <DropdownMenuItem key={publisher.id} onClick={() => setPending({ kind: "publish", publisher })}>
                  <Globe data-icon="inline-start" />
                  Publish with {publisher.manifest.contributes.publish.title}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {pending && (
        <ConfirmActionDialog
          open
          onOpenChange={(open) => { if (!open) setPending(null) }}
          title={pending.kind === "publish" ? `Publish “${title}”?` : "Take down the public page?"}
          description={pending.kind === "publish"
            ? <>Version {version} goes to {pending.publisher.manifest.contributes.publish.title}. Anyone with the link can open it, without signing in.</>
            : <>The link stops working. You can publish the view again later; it gets a new link.</>}
          confirmLabel={pending.kind === "publish" ? "Publish" : "Take down"}
          destructive={pending.kind === "unpublish"}
          onConfirm={() => {
            const host = pending.publisher.manifest.contributes.publish.title
            return pending.kind === "publish"
              ? run(async () => { await copyLink((await publish(pending.publisher, id, version)).url, "Published, link copied", "Published") }, host)
              : run(async () => { await unpublish(pending.publisher, id); toast.success("The public page is down") }, host)
          }}
        />
      )}
    </>
  )
}
