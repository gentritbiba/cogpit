import { useCallback, useEffect, useState } from "react"
import { AlertCircle, Link2Off, Users } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Spinner } from "@/components/ui/Spinner"
import { SharedLoginScreen } from "@/components/SharedSession/SharedLoginScreen"
import { SharedSessionView } from "@/components/SharedSession/SharedSessionView"
import { sharedSessionId } from "@/lib/sharePath"
import { probeSharedSession, SHARE_REVOKED_EVENT, type SharedSessionInfo } from "@/lib/shareApi"

/**
 * The whole guest application.
 *
 * Mounted instead of `DeviceRoot`, not inside it: the login gate, the setup
 * gate, device switching, the sidebar and the command palette are not
 * conditionally hidden here, they are absent, so there is no render path on
 * which a guest reaches a component that assumes host access.
 */

type ShareState =
  | { kind: "probing" }
  | { kind: "login" }
  | { kind: "ready"; info: SharedSessionInfo }
  | { kind: "error"; message: string }
  /** Terminal. The host revoked the share; nothing the guest does can undo it. */
  | { kind: "ended" }

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8">
      <div className="w-full max-w-sm">{children}</div>
    </main>
  )
}

export function SharedRoot() {
  const sessionId = sharedSessionId(window.location.pathname)
  const [state, setState] = useState<ShareState>(
    sessionId ? { kind: "probing" } : { kind: "error", message: "This share link is not valid." },
  )

  const probe = useCallback(async () => {
    setState({ kind: "probing" })
    const result = await probeSharedSession()
    setState(
      result.status === "ok" ? { kind: "ready", info: result.info }
        : result.status === "unauthenticated" ? { kind: "login" }
          : { kind: "error", message: result.message },
    )
  }, [])

  useEffect(() => {
    if (!sessionId) return
    void probe()
  }, [probe, sessionId])

  // Two signals, one meaning. Guest-owned calls announce a 401 directly; the
  // host hooks reused for the transcript (the tail loader, history paging) go
  // through authFetch, which announces the same thing under its own name.
  useEffect(() => {
    const end = () => {
      setState((current) => (current.kind === "ready" ? { kind: "ended" } : current))
    }
    window.addEventListener(SHARE_REVOKED_EVENT, end)
    window.addEventListener("cogpit-auth-required", end)
    return () => {
      window.removeEventListener(SHARE_REVOKED_EVENT, end)
      window.removeEventListener("cogpit-auth-required", end)
    }
  }, [])

  if (state.kind === "ready") return <SharedSessionView info={state.info} />

  if (state.kind === "login" && sessionId) {
    return <SharedLoginScreen sessionId={sessionId} onAuthenticated={() => void probe()} />
  }

  if (state.kind === "ended") {
    return (
      <CenteredCard>
        <Card>
          <CardHeader>
            <div className="mb-2 flex size-9 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
              <Link2Off className="size-4" />
            </div>
            <CardTitle>Sharing has ended</CardTitle>
            <CardDescription>
              The host stopped sharing this session or changed its passphrase. Ask for a new
              link to rejoin.
            </CardDescription>
          </CardHeader>
        </Card>
      </CenteredCard>
    )
  }

  if (state.kind === "error") {
    return (
      <CenteredCard>
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>Could not open this session</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
        {sessionId && (
          <Button className="mt-3 w-full" onClick={() => void probe()}>
            Try again
          </Button>
        )}
      </CenteredCard>
    )
  }

  return (
    <CenteredCard>
      <Card>
        <CardContent
          className="flex min-h-24 items-center justify-center gap-2"
          role="status"
          aria-label="Opening shared session"
        >
          <Users className="size-4 text-muted-foreground" aria-hidden="true" />
          <Spinner className="size-5 text-muted-foreground" />
        </CardContent>
      </Card>
    </CenteredCard>
  )
}
