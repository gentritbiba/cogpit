import { useCallback, useState } from "react"
import { AlertCircle, Eye, EyeOff, Users } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/Spinner"

interface SharedLoginScreenProps {
  sessionId: string
  onAuthenticated: () => void
}

/**
 * Wrong passphrase and unknown share return a byte-identical 401, and this is
 * the client half of that promise: the rejection text is a constant, so the
 * screen cannot leak whether the share exists even if the server body changes.
 */
const REJECTED = "Invalid link or passphrase."

/**
 * The statuses a guest can actually act on. The server's own wording for these
 * is written for an operator ("Network access is disabled"); a guest needs to
 * be told it is not their end and what to do instead.
 */
function loginErrorMessage(status: number, serverError: string | undefined): string {
  if (status === 401) return REJECTED
  if (status === 429) {
    return serverError || "Too many attempts. Try again in a minute."
  }
  if (status === 426) {
    return "This link needs a secure HTTPS connection. Open the tunnel URL instead of the plain http address."
  }
  if (status === 403) {
    return "Network access is off on the host, so this session cannot be joined right now."
  }
  return serverError || REJECTED
}

export function SharedLoginScreen({ sessionId, onAuthenticated }: SharedLoginScreenProps) {
  const [passphrase, setPassphrase] = useState("")
  const [showPassphrase, setShowPassphrase] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault()
    if (!passphrase.trim()) return

    setLoading(true)
    setError(null)

    try {
      const response = await fetch("/api/share/verify", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Cogpit-Client": "1",
        },
        body: JSON.stringify({ sessionId, passphrase }),
      })

      const data = await response.json() as { valid?: boolean; error?: string }
      if (response.ok && data.valid) {
        setPassphrase("")
        onAuthenticated()
      } else {
        setError(loginErrorMessage(response.status, data.error))
      }
    } catch {
      setError("Failed to connect to server")
    } finally {
      setLoading(false)
    }
  }, [onAuthenticated, passphrase, sessionId])

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8">
      <form onSubmit={handleSubmit} className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <div className="mb-2 flex size-9 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
              <Users className="size-4" />
            </div>
            <CardTitle>Join this session</CardTitle>
            <CardDescription>
              Enter the passphrase you were given to join the shared session.
            </CardDescription>
          </CardHeader>

          <CardContent className="flex flex-col gap-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="share-passphrase">Passphrase</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="share-passphrase"
                    type={showPassphrase ? "text" : "password"}
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                    placeholder="copper-lantern-drift-92"
                    autoComplete="current-password"
                    autoFocus
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      size="icon-xs"
                      onClick={() => setShowPassphrase((visible) => !visible)}
                      aria-label={showPassphrase ? "Hide passphrase" : "Show passphrase"}
                    >
                      {showPassphrase ? <EyeOff /> : <Eye />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </Field>
            </FieldGroup>

            {error && (
              <Alert variant="destructive">
                <AlertCircle aria-hidden="true" />
                <AlertTitle>Could not join</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </CardContent>

          <CardFooter>
            <Button type="submit" className="w-full" disabled={loading || !passphrase.trim()}>
              {loading && <Spinner data-icon="inline-start" />}
              Connect
            </Button>
          </CardFooter>
        </Card>
      </form>
    </main>
  )
}
