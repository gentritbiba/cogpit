import { CloudOff, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

/** The whole app while the connected server's own edition UI could not be fetched. */
export function EditionUiFailedScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="dark flex h-dvh items-center justify-center bg-canvas text-foreground">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CloudOff className="text-destructive" />
          </EmptyMedia>
          <EmptyTitle>Cogpit couldn’t finish loading</EmptyTitle>
          <EmptyDescription>Part of this server’s interface didn’t download. Check your connection and try again.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          <Button size="sm" onClick={onRetry}>
            <RefreshCw data-icon="inline-start" />
            Retry
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  )
}
