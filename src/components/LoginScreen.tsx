import { useState, useCallback } from "react"
import { Eye, EyeOff, Lock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { clearToken } from "@/lib/auth"
import { Spinner } from "@/components/ui/Spinner"

interface LoginScreenProps {
  onAuthenticated: () => void
}

export function LoginScreen({ onAuthenticated }: LoginScreenProps) {
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password.trim()) return

    setLoading(true)
    setError(null)

    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Authorization": `Bearer ${password}`,
          "Content-Type": "application/json",
          "X-Cogpit-Client": "1",
        },
      })

      const data = await res.json() as { valid?: boolean; error?: string }
      if (res.ok && data.valid) {
        // The server stores the session in an HttpOnly cookie. Scrub any token
        // left behind by an older build, then remove the password from memory.
        clearToken()
        setPassword("")
        onAuthenticated()
      } else {
        setError(data.error || "Invalid password")
      }
    } catch {
      setError("Failed to connect to server")
    } finally {
      setLoading(false)
    }
  }, [password, onAuthenticated])

  return (
    <div className="dark flex h-dvh items-center justify-center bg-elevation-0">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 px-6">
        <div className="flex flex-col items-center gap-3 mb-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-500/10 border border-blue-500/20">
            <Lock className="size-5 text-blue-400" />
          </div>
          <div className="text-center">
            <h1 className="text-lg font-semibold text-foreground">Cogpit</h1>
            <p className="text-sm text-muted-foreground">Enter the password to connect</p>
          </div>
        </div>

        <div className="relative">
          <Input
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete="current-password"
            className="pr-10 bg-elevation-1 border-border/70 focus:border-border"
            autoFocus
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

        {error && (
          <p className="text-sm text-red-400">{error}</p>
        )}

        <Button type="submit" className="w-full" disabled={loading || !password.trim()}>
          {loading ? <Spinner className="size-4 mr-2" /> : null}
          Connect
        </Button>
      </form>
    </div>
  )
}
