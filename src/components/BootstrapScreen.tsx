import { useCallback, useState } from "react"
import { AlertCircle, AlertTriangle, Eye, EyeOff, ShieldPlus } from "lucide-react"
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/Spinner"

const MIN_PASSWORD_LENGTH = 16
const BOOTSTRAP_TOKEN_STATE_KEY = "__cogpitBootstrapToken"

function takeBootstrapToken(): string {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""))
  const fromFragment = params.get("bootstrap") || ""
  const priorState = (window.history.state || {}) as Record<string, unknown>
  const token = fromFragment
    || (typeof priorState[BOOTSTRAP_TOKEN_STATE_KEY] === "string"
      ? priorState[BOOTSTRAP_TOKEN_STATE_KEY] as string
      : "")

  if (fromFragment) {
    window.history.replaceState(
      { ...priorState, [BOOTSTRAP_TOKEN_STATE_KEY]: fromFragment },
      "",
      `${window.location.pathname}${window.location.search}`,
    )
  }
  return token
}

function forgetBootstrapToken(): void {
  const next = { ...((window.history.state || {}) as Record<string, unknown>) }
  delete next[BOOTSTRAP_TOKEN_STATE_KEY]
  window.history.replaceState(next, "", `${window.location.pathname}${window.location.search}`)
}

interface BootstrapScreenProps {
  onAuthenticated: () => void
  onBootstrapClosed: () => Promise<void>
}

export function BootstrapScreen({ onAuthenticated, onBootstrapClosed }: BootstrapScreenProps) {
  const [bootstrapToken] = useState(takeBootstrapToken)
  const [username, setUsername] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const mismatch = confirmPassword.length > 0 && confirmPassword !== password
  const incomplete = !bootstrapToken
    || !username.trim()
    || password.length < MIN_PASSWORD_LENGTH
    || confirmPassword !== password

  const handleSubmit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault()
    if (incomplete) return

    setLoading(true)
    setError(null)

    try {
      const response = await fetch("/api/team/bootstrap", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Cogpit-Client": "1",
          "X-Cogpit-Bootstrap-Token": bootstrapToken,
        },
        body: JSON.stringify({
          username: username.trim(),
          password,
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        }),
      })

      const data = await response.json() as { error?: string }
      if (response.ok) {
        forgetBootstrapToken()
        setPassword("")
        setConfirmPassword("")
        setUsername("")
        setDisplayName("")
        await onBootstrapClosed()
        onAuthenticated()
        return
      }
      if (response.status === 410) {
        forgetBootstrapToken()
        await onBootstrapClosed()
        return
      }
      setError(data.error || "Could not create the admin account")
    } catch {
      setError("Failed to connect to server")
    } finally {
      setLoading(false)
    }
  }, [bootstrapToken, displayName, incomplete, onAuthenticated, onBootstrapClosed, password, username])

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8">
      <form onSubmit={handleSubmit} className="w-full max-w-md">
        <Card>
          <CardHeader>
            <div className="mb-2 flex size-9 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
              <ShieldPlus className="size-4" />
            </div>
            <CardTitle>Create the first admin</CardTitle>
            <CardDescription>
              Set up the account that will manage this Cogpit team server.
            </CardDescription>
          </CardHeader>

          <CardContent className="flex flex-col gap-4">
            {!bootstrapToken && (
              <Alert>
                <AlertTriangle aria-hidden="true" />
                <AlertTitle>Setup link required</AlertTitle>
                <AlertDescription>
                  Open the one-time setup URL shown in the Cogpit server log.
                </AlertDescription>
              </Alert>
            )}

            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="bootstrap-username">Username</FieldLabel>
                <Input
                  id="bootstrap-username"
                  type="text"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="Username"
                  autoComplete="username"
                  autoFocus
                />
                <FieldDescription>
                  Use 2 to 32 lowercase letters, numbers, dots, underscores, or hyphens.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="bootstrap-display-name">
                  Display name <span className="font-normal text-muted-foreground">Optional</span>
                </FieldLabel>
                <Input
                  id="bootstrap-display-name"
                  type="text"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Display name (optional)"
                  autoComplete="name"
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="bootstrap-password">Password</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="bootstrap-password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Password"
                    autoComplete="new-password"
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      size="icon-xs"
                      onClick={() => setShowPassword((visible) => !visible)}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                    >
                      {showPassword ? <EyeOff /> : <Eye />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                <FieldDescription>
                  Use at least {MIN_PASSWORD_LENGTH} characters.
                </FieldDescription>
              </Field>

              <Field data-invalid={mismatch}>
                <FieldLabel htmlFor="bootstrap-confirm-password">Confirm password</FieldLabel>
                <Input
                  id="bootstrap-confirm-password"
                  type={showPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="Confirm password"
                  autoComplete="new-password"
                  aria-invalid={mismatch}
                />
                {mismatch && <FieldError>Passwords do not match</FieldError>}
              </Field>
            </FieldGroup>

            {error && (
              <Alert variant="destructive">
                <AlertCircle aria-hidden="true" />
                <AlertTitle>Could not create the account</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </CardContent>

          <CardFooter>
            <Button type="submit" className="w-full" disabled={loading || incomplete}>
              {loading && <Spinner data-icon="inline-start" />}
              Create admin account
            </Button>
          </CardFooter>
        </Card>
      </form>
    </main>
  )
}
