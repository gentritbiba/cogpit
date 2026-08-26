import { useRef } from "react"
import { AlertCircle, Users } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Spinner } from "@/components/ui/Spinner"
import { ChatArea } from "@/components/ChatArea"
import { ChatInput } from "@/components/ChatInput"
import { SessionInputFooter } from "@/components/AppShell/SessionInputFooter"
import { ShareScopedProviders } from "@/contexts/ShareScopedProviders"
import type { ShareViewState } from "@/contexts/ShareScopedProviders"
import type { SharedSessionInfo } from "@/lib/shareApi"

interface SharedSessionViewProps {
  info: SharedSessionInfo
}

/**
 * What a guest sees: the transcript and the composer, and nothing else.
 *
 * There is no sidebar, no command palette, no file browser and no session
 * switcher — not hidden behind a capability check but absent from the tree, so
 * no guest render path can reach a component that assumes host access.
 */
export function SharedSessionView({ info }: SharedSessionViewProps) {
  const searchInputRef = useRef<HTMLInputElement>(null)

  return (
    <ShareScopedProviders info={info}>
      {(view: ShareViewState) => (
        <div className="flex h-dvh min-h-0 flex-col bg-background">
          <header className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
            <Users className="size-4 text-muted-foreground" aria-hidden="true" />
            <h1 className="truncate text-sm font-medium text-foreground">{info.title}</h1>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">Guest view</span>
          </header>

          {view.loadState === "failed" ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <Alert variant="destructive" className="max-w-sm">
                <AlertCircle aria-hidden="true" />
                <AlertTitle>Session unavailable</AlertTitle>
                <AlertDescription>
                  This conversation could not be loaded. It may have been deleted on the host.
                </AlertDescription>
              </Alert>
            </div>
          ) : view.loadState === "loading" ? (
            <div
              className="flex flex-1 items-center justify-center"
              role="status"
              aria-label="Loading shared session"
            >
              <Spinner className="size-5 text-muted-foreground" />
            </div>
          ) : (
            <>
              <ChatArea
                searchInputRef={searchInputRef}
                hasMore={view.hasMore}
                isLoadingOlder={view.isLoadingOlder}
                onLoadMore={view.loadMore}
              />
              <SessionInputFooter>
                <ChatInput agentKind={info.provider} projectCwd={null} />
              </SessionInputFooter>
            </>
          )}
        </div>
      )}
    </ShareScopedProviders>
  )
}
