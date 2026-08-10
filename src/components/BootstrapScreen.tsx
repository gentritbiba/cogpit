import { useState, useCallback } from "react"
import { Eye, EyeOff, ShieldPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/Spinner"

/**
 * First-run screen for a team server with no accounts. Creates the founding
 * admin through `POST /api/team/bootstrap`, which also issues the session
 * cookie — so a success lands straight in the app, exactly like a login.
 *
 * The server owns every rule; the checks here only keep an obviously incomplete
 * form from making a round trip. Its error strings are shown verbatim.
 */

/** Mirrors the server rule so the button is not disabled without saying why. */
const MIN_PASSWORD_LENGTH = 16

interface BootstrapScreenProps {
  /** Same handler LoginScreen uses — the session cookie is already set. */
  onAuthenticated: () => void
  /** Re-read the server handshake once the bootstrap is no longer open. */
  onBootstrapClosed: () => Promise<void>
}

export function BootstrapScreen({ onAuthenticated, onBootstrapClosed }: BootstrapScreenProps) {
  const [username, setUsername] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const mismatch = confirmPassword.length > 0 && confirmPassword !== password
  const incomplete = !username.trim()
    || password.length < MIN_PASSWORD_LENGTH
    || confirmPassword !== password

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (incomplete) return

    setLoading(true)
    setError(null)

    try {
      const res = await fetch("/api/team/bootstrap", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Cogpit-Client": "1",
        },
        body: JSON.stringify({
          username: username.trim(),
          password,
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        }),
      })

      const data = await res.json() as { error?: string }
      if (res.ok) {
        setPassword("")
        setConfirmPassword("")
        setUsername("")
        setDisplayName("")
        await onBootstrapClosed()
        onAuthenticated()
        return
      }
      if (res.status === 410) {
        // Someone else founded the server first. Re-reading the handshake
        // closes this screen and hands the browser to the login form.
        await onBootstrapClosed()
        return
      }
      setError(data.error || "Could not create the admin account")
    } catch {
      setError("Failed to connect to server")
    } finally {
      setLoading(false)
    }
  }, [username, displayName, password, incomplete, onAuthenticated, onBootstrapClosed])

  return (
    <div className="dark flex h-dvh items-center justify-center bg-elevation-0">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 px-6">
        <div className="flex flex-col items-center gap-3 mb-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-500/10 border border-blue-500/20">
            <ShieldPlus className="size-5 text-blue-400" />
          </div>
          <div className="text-center">
            <h1 className="text-lg font-semibold text-foreground">Create the first admin</h1>
            <p className="text-sm text-muted-foreground">
              This Cogpit team server has no accounts yet.
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            autoComplete="username"
            className="bg-elevation-1 border-border/70 focus:border-border"
            autoFocus
          />
          <p className="text-xs text-muted-foreground">
            Lowercase letters, numbers, dots, underscores or hyphens. 2–32 characters.
          </p>
        </div>

        <Input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Display name (optional)"
          autoComplete="name"
          className="bg-elevation-1 border-border/70 focus:border-border"
        />

        <div className="space-y-1.5">
          <div className="relative">
            <Input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoComplete="new-password"
              className="pr-10 bg-elevation-1 border-border/70 focus:border-border"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            At least {MIN_PASSWORD_LENGTH} characters.
          </p>
        </div>

        <Input
          type={showPassword ? "text" : "password"}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="Confirm password"
          autoComplete="new-password"
          className="bg-elevation-1 border-border/70 focus:border-border"
          aria-invalid={mismatch}
        />

        {mismatch && (
          <p className="text-sm text-red-400">Passwords do not match</p>
        )}

        {error && (
          <p className="text-sm text-red-400">{error}</p>
        )}

        <Button type="submit" className="w-full" disabled={loading || incomplete}>
          {loading ? <Spinner className="size-4 mr-2" /> : null}
          Create admin account
        </Button>
      </form>
    </div>
  )
}
