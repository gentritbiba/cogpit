import { useCallback, useState } from "react"
import { CheckCircle, ChevronDown, ChevronRight, FolderOpen, Sparkles, XCircle } from "lucide-react"
import { AgentCheckView, CheckAgainButton } from "@/components/AgentCheck/AgentCheckView"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/Spinner"
import { useAgentCheck } from "@/hooks/useAgentCheck"
import { useConfigValidation } from "@/hooks/useConfigValidation"
import { soleDescriptorWhere } from "@/lib/agents"
import { authFetch } from "@/lib/auth"
import { agentReadiness, canContinueSetup } from "../../shared/contracts/agentCheck"

interface SetupScreenProps {
  /** Called once a configuration exists, so the app can load it. */
  onConfigured: () => void
}

/** The one agent whose home Cogpit has to be told about when it moved. */
const configuredAgent = soleDescriptorWhere(
  (descriptor) => !descriptor.cli.homeIsDiscoverable,
  "a home Cogpit has to be told about",
)

/** The configured agent keeps its history somewhere else: point Cogpit at it. */
function CustomFolder({ onConfigured }: SetupScreenProps) {
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState("")
  const [saving, setSaving] = useState(false)
  const { status, error, debouncedValidate, save } = useConfigValidation()

  const handleSave = useCallback(async () => {
    setSaving(true)
    const result = await save(path)
    setSaving(false)
    if (result.success) onConfigured()
  }, [onConfigured, path, save])

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        render={<Button type="button" variant="ghost" size="sm" className="-ml-2 text-muted-foreground" />}
      >
        {open ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}
        Advanced
      </CollapsibleTrigger>
      <CollapsibleContent>
        <form
          className="pt-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (status === "valid" && !saving) void handleSave()
          }}
        >
          <Field data-invalid={status === "invalid"}>
            <FieldLabel htmlFor="agent-data-directory">{configuredAgent.displayName} folder</FieldLabel>
            <FieldDescription>
              Only needed if you moved it. It is usually{" "}
              <code className="font-mono text-xs">~/{configuredAgent.cli.homeDirName}</code>.
            </FieldDescription>
            <div className="flex gap-2">
              <InputGroup>
                <InputGroupAddon>
                  <FolderOpen aria-hidden="true" />
                </InputGroupAddon>
                <InputGroupInput
                  id="agent-data-directory"
                  value={path}
                  onChange={(event) => {
                    setPath(event.target.value)
                    debouncedValidate(event.target.value)
                  }}
                  placeholder={`~/${configuredAgent.cli.homeDirName}`}
                  aria-invalid={status === "invalid"}
                  aria-describedby="agent-directory-status"
                />
              </InputGroup>
              <Button type="submit" variant="outline" disabled={status !== "valid" || saving}>
                {saving && <Spinner data-icon="inline-start" />}
                Use this folder
              </Button>
            </div>
            <div id="agent-directory-status" className="min-h-5" role="status" aria-live="polite">
              {status === "validating" && (
                <FieldDescription className="flex items-center gap-2">
                  <Spinner className="size-4" />
                  Checking…
                </FieldDescription>
              )}
              {status === "valid" && (
                <FieldDescription className="flex items-center gap-2 text-success">
                  <CheckCircle className="size-4" />
                  Folder found
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
        </form>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * First-run gate, shown while no agent CLI has been found: one row per agent
 * with how to install it or sign in, and Continue once any of them can start.
 */
export function SetupScreen({ onConfigured }: SetupScreenProps) {
  const check = useAgentCheck()
  const [continuing, setContinuing] = useState(false)
  const [continueError, setContinueError] = useState<string | null>(null)
  const agents = check.agents ?? []
  const canContinue = canContinueSetup(agents)
  const anyReady = agents.some((agent) => agentReadiness(agent) === "ready")

  const handleContinue = useCallback(async () => {
    setContinuing(true)
    setContinueError(null)
    try {
      const res = await authFetch("/api/config/detect", { method: "POST" })
      if (res.ok) {
        onConfigured()
        return
      }
      const data = (await res.json().catch(() => null)) as { error?: string } | null
      setContinueError(data?.error ?? "Cogpit couldn't save your setup. Try again.")
    } catch {
      setContinueError("Cogpit couldn't reach its server. Try again.")
    } finally {
      setContinuing(false)
    }
  }, [onConfigured])

  let hint: string | null = null
  if (check.agents && !canContinue) hint = "Install one of these, then select Check again."
  else if (canContinue && !anyReady) hint = "You can sign in now, or after you continue."

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-8 text-foreground">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <div className="mb-2 flex size-9 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
            <Sparkles className="size-4" />
          </div>
          <CardTitle>Set up your coding agent</CardTitle>
          <CardDescription>
            Cogpit works with AI coding agents installed on this computer. You need at least one.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-3">
          <AgentCheckView check={check} />
          <CustomFolder onConfigured={onConfigured} />
        </CardContent>

        <CardFooter className="flex flex-col items-stretch gap-2">
          <div className="flex gap-2">
            <CheckAgainButton check={check} />
            <Button
              type="button"
              className="flex-1"
              disabled={!canContinue || continuing}
              onClick={() => void handleContinue()}
            >
              {continuing && <Spinner data-icon="inline-start" />}
              Continue
            </Button>
          </div>
          {continueError
            ? <p className="text-xs text-destructive" role="alert">{continueError}</p>
            : hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </CardFooter>
      </Card>
    </main>
  )
}
