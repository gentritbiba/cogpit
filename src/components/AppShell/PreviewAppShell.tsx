import type { ReactNode, RefObject } from "react"
import { CircleAlert, Loader2 } from "lucide-react"
import { ChatArea } from "@/components/ChatArea"
import { SessionInputFooter } from "@/components/AppShell/SessionInputFooter"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"

interface PreviewAppShellProps {
  sessionId: string
  loadError: string | null
  searchInputRef: RefObject<HTMLInputElement | null>
  activeComposer: ReactNode
  hasMoreTurns: boolean
  isLoadingOlderTurns: boolean
  onLoadMoreTurns: () => void
  status: ReactNode
}

/** Session-only local surface used by `cogpit preview <session-id>`. */
export function PreviewAppShell({
  sessionId,
  loadError,
  searchInputRef,
  activeComposer,
  hasMoreTurns,
  isLoadingOlderTurns,
  onLoadMoreTurns,
  status,
}: PreviewAppShellProps) {
  const { theme, isMobile } = useAppContext()
  const { session } = useSessionContext()

  return (
    <div className={`${theme.themeClasses} flex h-dvh flex-col overflow-hidden bg-elevation-0 text-foreground`}>
      {session ? (
        <main className="relative flex min-h-0 flex-1 flex-col">
          <ChatArea
            searchInputRef={searchInputRef}
            hasMore={hasMoreTurns}
            isLoadingOlder={isLoadingOlderTurns}
            onLoadMore={onLoadMoreTurns}
          />
          {isMobile ? (
            activeComposer
          ) : (
            <SessionInputFooter floating>{activeComposer}</SessionInputFooter>
          )}
        </main>
      ) : (
        <main className="flex min-h-0 flex-1 items-center justify-center p-6">
          <Empty className="max-w-md">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {loadError ? <CircleAlert /> : <Loader2 className="animate-spin" />}
              </EmptyMedia>
              <EmptyTitle>{loadError ? "Unable to open session" : "Opening session"}</EmptyTitle>
              <EmptyDescription>
                {loadError ?? `Looking for ${sessionId} in your local Claude and Codex history.`}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </main>
      )}
      {status}
    </div>
  )
}
