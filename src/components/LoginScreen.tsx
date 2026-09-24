import { useCallback, useEffect, useState } from "react"
import { AlertCircle, Eye, EyeOff, Info, Lock } from "lucide-react"
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
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/Spinner"
import { useEditionUi } from "@/edition/hooks"
import { clearToken, getServerSignIn } from "@/lib/auth"
import type { SignInMode } from "../../shared/contracts/identity"

interface LoginScreenProps {
  onAuthenticated: () => void
  /** The server has no account yet, and this build has no screen to create one. */
  setupRequired?: boolean
}

export function LoginScreen({ onAuthenticated, setupRequired = false }: LoginScreenProps) {
  const [signIn, setSignIn] = useState<SignInMode | null>(null)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const usesAccounts = signIn === "account"
  const { LoginNotice } = useEditionUi()

  useEffect(() => {
    let cancelled = false
    void getServerSignIn().then((resolved) => {
      if (!cancelled) setSignIn(resolved)
    })
    return () => { cancelled = true }
  }, [])

  const handleSubmit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault()
    if (!password.trim() || (usesAccounts && !username.trim())) return

    setLoading(true)
    setError(null)

    try {
      const response = await fetch("/api/auth/verify", usesAccounts
        ? {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: {
              "Content-Type": "application/json",
              "X-Cogpit-Client": "1",
            },
            body: JSON.stringify({ username: username.trim(), password }),
          }
        : {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: {
              "Authorization": `Bearer ${password}`,
              "Content-Type": "application/json",
              "X-Cogpit-Client": "1",
            },
          })

      const data = await response.json() as { valid?: boolean; error?: string }
      if (response.ok && data.valid) {
        clearToken()
        setPassword("")
        setUsername("")
        onAuthenticated()
      } else {
        setError(data.error || (usesAccounts ? "Invalid credentials" : "Invalid password"))
      }
    } catch {
      setError("Failed to connect to server")
    } finally {
      setLoading(false)
    }
  }, [usesAccounts, onAuthenticated, password, username])

  const submitDisabled = loading || !password.trim() || (usesAccounts && !username.trim())

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-8">
      <form onSubmit={handleSubmit} className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <div className="mb-2 flex size-9 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
              <Lock className="size-4" />
            </div>
            <CardTitle>Sign in to Cogpit</CardTitle>
            <CardDescription>
              {usesAccounts ? "Sign in with your account to continue." : "Enter the server password to continue."}
            </CardDescription>
          </CardHeader>

          {signIn === null ? (
            <CardContent>
              <div
                className="flex min-h-24 items-center justify-center"
                role="status"
                aria-label="Checking server"
              >
                <Spinner className="size-5 text-muted-foreground" />
              </div>
            </CardContent>
          ) : (
            <>
              <CardContent className="flex flex-col gap-4">
                {setupRequired && (
                  <Alert>
                    <Info aria-hidden="true" />
                    <AlertDescription>This server has no accounts yet.</AlertDescription>
                  </Alert>
                )}

                <FieldGroup>
                  {usesAccounts && (
                    <Field>
                      <FieldLabel htmlFor="login-username">Username</FieldLabel>
                      <Input
                        id="login-username"
                        type="text"
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        placeholder="Username"
                        autoComplete="username"
                        autoFocus
                      />
                    </Field>
                  )}

                  <Field>
                    <FieldLabel htmlFor="login-password">Password</FieldLabel>
                    <InputGroup>
                      <InputGroupInput
                        id="login-password"
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        placeholder="Password"
                        autoComplete="current-password"
                        autoFocus={!usesAccounts}
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
                  </Field>
                </FieldGroup>

                {usesAccounts && LoginNotice && <LoginNotice />}

                {error && (
                  <Alert variant="destructive">
                    <AlertCircle aria-hidden="true" />
                    <AlertTitle>Sign in failed</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
              </CardContent>

              <CardFooter>
                <Button type="submit" className="w-full" disabled={submitDisabled}>
                  {loading && <Spinner data-icon="inline-start" />}
                  Connect
                </Button>
              </CardFooter>
            </>
          )}
        </Card>
      </form>
    </main>
  )
}
