import { useCallback, useState } from "react"
import { CheckCircle, FolderOpen, Settings2, XCircle } from "lucide-react"
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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/Spinner"
import { useConfigValidation } from "@/hooks/useConfigValidation"

interface SetupScreenProps {
  onConfigured: (claudeDir: string) => void
}

export function SetupScreen({ onConfigured }: SetupScreenProps) {
  const [path, setPath] = useState("")
  const [saving, setSaving] = useState(false)
  const { status, error, debouncedValidate, save } = useConfigValidation()

  const handleChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value
    setPath(value)
    debouncedValidate(value)
  }, [debouncedValidate])

  const handleSave = useCallback(async () => {
    setSaving(true)
    const result = await save(path)
    if (result.success && result.claudeDir) {
      onConfigured(result.claudeDir)
    }
    setSaving(false)
  }, [onConfigured, path, save])

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground">
      <form
        className="w-full max-w-lg"
        onSubmit={(event) => {
          event.preventDefault()
          if (status === "valid" && !saving) void handleSave()
        }}
      >
        <Card>
          <CardHeader>
            <div className="mb-2 flex size-9 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
              <Settings2 className="size-4" />
            </div>
            <CardTitle>Connect your coding agent</CardTitle>
            <CardDescription>
              Cogpit detects Codex and GitHub Copilot CLI automatically. Existing histories live in{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">~/.codex</code>{" "}
              and{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">~/.copilot/session-state</code>.{" "}
              For Claude Code, enter its data directory, usually{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">~/.claude</code>.
            </CardDescription>
          </CardHeader>

          <CardContent>
            <FieldGroup>
              <Field data-invalid={status === "invalid"}>
                <FieldLabel htmlFor="claude-data-directory">
                  Claude Code data directory
                </FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <FolderOpen aria-hidden="true" />
                  </InputGroupAddon>
                  <InputGroupInput
                    id="claude-data-directory"
                    value={path}
                    onChange={handleChange}
                    placeholder="/Users/you/.claude"
                    autoFocus
                    aria-invalid={status === "invalid"}
                    aria-describedby="claude-directory-status"
                  />
                </InputGroup>

                <div
                  id="claude-directory-status"
                  className="min-h-5"
                  role="status"
                  aria-live="polite"
                >
                  {status === "validating" && (
                    <FieldDescription className="flex items-center gap-2">
                      <Spinner className="size-4" />
                      Checking path...
                    </FieldDescription>
                  )}
                  {status === "valid" && (
                    <FieldDescription className="flex items-center gap-2 text-success">
                      <CheckCircle className="size-4" />
                      Claude Code history found
                    </FieldDescription>
                  )}
                  {status === "invalid" && error && (
                    <FieldError className="flex items-center gap-2">
                      <XCircle className="size-4" />
                      {error}
                    </FieldError>
                  )}
                </div>
              </Field>
            </FieldGroup>
          </CardContent>

          <CardFooter>
            <Button
              type="submit"
              className="w-full"
              disabled={status !== "valid" || saving}
            >
              {saving && <Spinner data-icon="inline-start" />}
              {saving ? "Saving..." : "Connect Claude Code"}
            </Button>
          </CardFooter>
        </Card>
      </form>
    </main>
  )
}
