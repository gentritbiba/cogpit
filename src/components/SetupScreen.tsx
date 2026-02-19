import { useState, useCallback, useEffect, useRef } from "react"
import { Cog, FolderOpen, CheckCircle, XCircle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card } from "@/components/ui/card"
import { useConfigValidation } from "@/hooks/useConfigValidation"

interface SetupScreenProps {
  onConfigured: (claudeDir: string) => void
}

export function SetupScreen({ onConfigured }: SetupScreenProps) {
  const [path, setPath] = useState("")
  const [saving, setSaving] = useState(false)
  const { status, error, debouncedValidate, save } = useConfigValidation()
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      setPath(value)
      debouncedValidate(value)
    },
    [debouncedValidate]
  )

  const handleSave = useCallback(async () => {
    setSaving(true)
    const result = await save(path)
    if (result.success && result.claudeDir) {
      onConfigured(result.claudeDir)
    }
    setSaving(false)
  }, [path, save, onConfigured])

  return (
    <div className="flex h-dvh items-center justify-center bg-zinc-950 text-zinc-100">
      <Card className="w-full max-w-md mx-4 p-6 bg-zinc-900 border-zinc-800">
        <div className="flex flex-col items-center gap-4">
          <Cog className="size-8 text-blue-400" />
          <h1 className="text-xl font-semibold tracking-tight">Cogpit Setup</h1>
          <p className="text-sm text-zinc-400 text-center leading-relaxed">
            Enter the path to your <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">.claude</code> directory
            to get started. This is typically located at{" "}
            <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">~/.claude</code>.
          </p>

          <div className="w-full space-y-3 mt-2">
            <div className="relative">
              <FolderOpen className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
              <Input
                value={path}
                onChange={handleChange}
                placeholder="/Users/you/.claude"
                ref={inputRef}
                className="pl-10 bg-zinc-950 border-zinc-700 focus:border-zinc-600"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && status === "valid" && !saving) handleSave()
                }}
              />
            </div>

            {status === "validating" && (
              <div className="flex items-center gap-2 text-sm text-zinc-400">
                <Loader2 className="size-3.5 animate-spin" />
                Checking path...
              </div>
            )}
            {status === "valid" && (
              <div className="flex items-center gap-2 text-sm text-green-400">
                <CheckCircle className="size-3.5" />
                Valid .claude directory found
              </div>
            )}
            {status === "invalid" && error && (
              <div className="flex items-center gap-2 text-sm text-red-400">
                <XCircle className="size-3.5" />
                {error}
              </div>
            )}

            <Button
              className="w-full"
              disabled={status !== "valid" || saving}
              onClick={handleSave}
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin mr-2" />
                  Saving...
                </>
              ) : (
                "Continue"
              )}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
