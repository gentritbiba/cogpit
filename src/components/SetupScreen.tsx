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
import { allDescriptors, soleDescriptorWhere } from "@/lib/agents"

interface SetupScreenProps {
  onConfigured: (claudeDir: string) => void
}

/** The one agent whose home Cogpit cannot find on its own and has to be told. */
const configuredAgent = soleDescriptorWhere(
  (descriptor) => !descriptor.cli.homeIsDiscoverable,
  "a home Cogpit has to be told about",
)
/** The rest are found where their CLIs keep them. */
const detectedAgents = allDescriptors().filter((descriptor) => descriptor.cli.homeIsDiscoverable)

/** `a`, `a and b`, `a, b and c`. */
function joinNames(parts: readonly React.ReactNode[]): React.ReactNode[] {
  return parts.flatMap((part, index) => {
    if (index === 0) return [part]
    return [index === parts.length - 1 ? " and " : ", ", part]
  })
}

function Path({ children }: { children: string }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">{children}</code>
}

const detectedNames = joinNames(detectedAgents.map((descriptor) => descriptor.displayName))
const detectedHomes = joinNames(detectedAgents.map((descriptor) => (
  <Path key={descriptor.kind}>
    {["~", descriptor.cli.homeDirName, descriptor.cli.installMarker].filter(Boolean).join("/")}
  </Path>
)))
const configuredHome = `~/${configuredAgent.cli.homeDirName}`

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
              Cogpit detects {detectedNames} automatically. Existing histories live in{" "}
              {detectedHomes}.{" "}
              For {configuredAgent.displayName}, enter its data directory, usually{" "}
              <Path>{configuredHome}</Path>.
            </CardDescription>
          </CardHeader>

          <CardContent>
            <FieldGroup>
              <Field data-invalid={status === "invalid"}>
                <FieldLabel htmlFor="agent-data-directory">
                  {configuredAgent.displayName} data directory
                </FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <FolderOpen aria-hidden="true" />
                  </InputGroupAddon>
                  <InputGroupInput
                    id="agent-data-directory"
                    value={path}
                    onChange={handleChange}
                    placeholder={`/Users/you/${configuredAgent.cli.homeDirName}`}
                    autoFocus
                    aria-invalid={status === "invalid"}
                    aria-describedby="agent-directory-status"
                  />
                </InputGroup>

                <div
                  id="agent-directory-status"
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
                      {configuredAgent.displayName} history found
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
              {saving ? "Saving..." : `Connect ${configuredAgent.displayName}`}
            </Button>
          </CardFooter>
        </Card>
      </form>
    </main>
  )
}
