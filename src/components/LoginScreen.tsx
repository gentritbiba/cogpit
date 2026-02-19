import { useState, useCallback, useEffect, useRef } from "react"
import { Eye, EyeOff, Lock, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { setToken } from "@/lib/auth"

interface LoginScreenProps {
  onAuthenticated: () => void
}

export function LoginScreen({ onAuthenticated }: LoginScreenProps) {
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password.trim()) return

    setLoading(true)
    setError(null)

    let res: Response
    let data: { valid?: boolean; token?: string; error?: string }
    try {
      res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${password}`,
          "Content-Type": "application/json",
        },
      })
      data = await res.json()
    } catch {
      setError("Failed to connect to server")
      setLoading(false)
      return
    }
    if (res.ok && data.valid) {
      setToken(data.token || password)
      onAuthenticated()
    } else {
      setError(data.error || "Invalid password")
    }
    setLoading(false)
  }, [password, onAuthenticated])

  return (
    <div className="dark flex h-dvh items-center justify-center bg-zinc-950">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 px-6">
        <div className="flex flex-col items-center gap-3 mb-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-500/10 border border-blue-500/20">
            <Lock className="size-5 text-blue-400" />
          </div>
          <div className="text-center">
            <h1 className="text-lg font-semibold text-zinc-100">Cogpit</h1>
            <p className="text-sm text-zinc-500">Enter the password to connect</p>
          </div>
        </div>

        <div className="relative">
          <Input
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            ref={inputRef}
            className="pr-10 bg-zinc-900 border-zinc-700 focus:border-zinc-600"
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
          >
            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>

        {error && (
          <p className="text-sm text-red-400">{error}</p>
        )}

        <Button type="submit" className="w-full" disabled={loading || !password.trim()}>
          {loading ? <Loader2 className="size-4 animate-spin mr-2" /> : null}
          Connect
        </Button>
      </form>
    </div>
  )
}
