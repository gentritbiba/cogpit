import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  XCircle,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { cn } from "@/lib/utils"
import { switchDevice } from "@/lib/device"
import {
  deviceEdition,
  deviceVersion,
  useDevices,
  type DeviceHello,
  type MutationResult,
  type ProbeResult,
  type PublicDevice,
  type UpdateDeviceInput,
} from "@/hooks/useDevices"
import packageJson from "../../package.json"

const HUB_VERSION = packageJson.version
const DEFAULT_PORT = 19384
const DEFAULT_TLS_PORT = 443
const PROBE_DEBOUNCE_MS = 450

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || "")
const SWITCH_TIP = `${IS_MAC ? "⌘⇧" : "Ctrl+Shift+"}1–9`

// Which field an add-error code belongs under.
const PASSWORD_CODES = new Set(["BAD_PASSWORD", "PASSWORD_REQUIRED", "USERNAME_REQUIRES_PASSWORD"])
const USERNAME_CODES = new Set(["ACCOUNT_DISABLED"])

interface DevicesDialogProps {
  open: boolean
  initialMode: "add" | "manage"
  onClose: () => void
  onCloseComplete?: () => void
}

/**
 * Split a "host" or "host:port" entry. A pasted `https://` prefix marks the
 * device as TLS (default port 443); a pasted `http://` prefix is just dropped.
 */
export function parseHostPort(input: string): { host: string; port?: number; tls?: true } {
  const trimmed = input.trim()
  const tls = /^https:\/\//i.test(trimmed)
  const noScheme = trimmed.replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
  const match = /^(.+):(\d+)$/.exec(noScheme)
  const host = match ? match[1] : noScheme
  const port = match ? Number(match[2]) : undefined
  return tls ? { host, port, tls: true } : { host, port }
}

type ProbeTone = "ok" | "warn" | "info" | "error"

interface ProbeDisplayState {
  tone: ProbeTone
  text: string
  hello?: DeviceHello
}

/** Turn a probe result into actionable, human copy. */
export function probeMessage(
  result: ProbeResult,
  host: string,
  port: number,
): { tone: ProbeTone; text: string } {
  if (result.ok) {
    if (result.hello.edition === "team" && result.hello.needsBootstrap === true) {
      return {
        tone: "info",
        text: "Reachable team server — create its first admin account before adding it here.",
      }
    }
    if (result.hello.edition !== "team" && result.hello.networkAccess === false) {
      return {
        tone: "warn",
        text: "Cogpit is running but network access is disabled — enable it in that device's settings.",
      }
    }
    if (result.hello.configured === false) {
      return {
        tone: "info",
        text: "Reachable — this device hasn't finished setup yet and will show its setup screen.",
      }
    }
    const name = result.hello.name ? ` "${result.hello.name}"` : ""
    const version = result.hello.version ? ` (v${result.hello.version})` : ""
    return { tone: "ok", text: `Found Cogpit${name}${version}.` }
  }
  switch (result.code) {
    case "UNREACHABLE":
      return {
        tone: "error",
        text: `Can't reach ${host}:${port}. Is Cogpit running with network access enabled?`,
      }
    case "LEGACY_NO_HELLO":
      return { tone: "error", text: "That Cogpit is too old for multi-device — update it." }
    case "NOT_COGPIT":
      return { tone: "error", text: "Something responded, but it isn't Cogpit." }
    case "SELF_ADD":
      return { tone: "error", text: "That's this machine." }
    default:
      return { tone: "error", text: result.error ?? "Could not reach the device." }
  }
}

const TONE_CLASS: Record<ProbeTone, string> = {
  ok: "text-success",
  warn: "text-warning",
  info: "text-info",
  error: "text-destructive",
}

function ToneIcon({ tone }: { tone: ProbeTone }) {
  const className = cn("size-3.5 shrink-0", TONE_CLASS[tone])
  if (tone === "ok") return <CheckCircle2 data-icon="inline-start" className={className} />
  if (tone === "warn") return <AlertTriangle data-icon="inline-start" className={className} />
  if (tone === "info") return <RefreshCw data-icon="inline-start" className={className} />
  return <XCircle data-icon="inline-start" className={className} />
}

// ── Existing-device row ──────────────────────────────────────────────────────

const AUTH_STATE_DOT: Record<PublicDevice["runtime"]["authState"], string> = {
  ok: "bg-success",
  unknown: "bg-warning",
  "bad-password": "bg-destructive",
}

interface DeviceRowProps {
  device: PublicDevice
  hubVersion: string
  onRename: (id: string, name: string) => Promise<void>
  onCredentials: (id: string, patch: UpdateDeviceInput) => Promise<MutationResult>
  onRemove: (id: string) => Promise<void>
  onTest: (id: string) => Promise<void>
}

function DeviceRow({ device, hubVersion, onRename, onCredentials, onRemove, onTest }: DeviceRowProps) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(device.name)
  const [editingCredentials, setEditingCredentials] = useState(false)
  const [credentialUsername, setCredentialUsername] = useState(device.username ?? "")
  const [credentialPassword, setCredentialPassword] = useState("")
  const [credentialError, setCredentialError] = useState<string | null>(null)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [busy, setBusy] = useState<null | "rename" | "credentials" | "remove" | "test">(null)

  useEffect(() => {
    setName(device.name)
  }, [device.name])

  useEffect(() => {
    setCredentialUsername(device.username ?? "")
  }, [device.username])

  const version = deviceVersion(device)
  const skewed = version !== undefined && version !== hubVersion
  const teamDevice = deviceEdition(device) === "team"

  async function saveName() {
    const trimmed = name.trim()
    if (!trimmed || trimmed === device.name) {
      setEditing(false)
      setName(device.name)
      return
    }
    setBusy("rename")
    await onRename(device.id, trimmed)
    setBusy(null)
    setEditing(false)
  }

  async function saveCredentials() {
    const username = credentialUsername.trim()
    const currentUsername = device.username ?? ""
    const usernameChanged = username !== currentUsername
    const passwordChanged = credentialPassword.length > 0
    if (!usernameChanged && !passwordChanged) {
      setEditingCredentials(false)
      setCredentialPassword("")
      setCredentialError(null)
      return
    }
    if (device.auth === "none" && !passwordChanged) {
      setCredentialError("Enter a password when adding an account to an unauthenticated device.")
      return
    }

    const patch: UpdateDeviceInput = {}
    if (usernameChanged) patch.username = username || null
    if (passwordChanged) patch.password = credentialPassword

    setBusy("credentials")
    setCredentialError(null)
    const result = await onCredentials(device.id, patch)
    setBusy(null)
    if (!result.ok) {
      setCredentialError(result.error)
      return
    }
    setEditingCredentials(false)
    setCredentialPassword("")
  }

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center gap-2.5 px-3 py-2">
        <span
          aria-label={`Status: ${device.runtime.authState}`}
          className={cn("size-2 shrink-0 rounded-full", AUTH_STATE_DOT[device.runtime.authState])}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {editing ? (
            <Input
              value={name}
              autoFocus
              aria-label={`Rename ${device.name}`}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveName()
                if (event.key === "Escape") {
                  setEditing(false)
                  setName(device.name)
                }
              }}
              onBlur={() => void saveName()}
              className="h-6 text-sm"
            />
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm text-foreground">{device.name}</span>
              {version && (
                <span
                  className={cn("shrink-0 font-mono text-xs", skewed ? "text-warning" : "text-muted-foreground")}
                  title={skewed ? `Device runs v${version}; hub runs v${hubVersion}` : undefined}
                >
                  v{version}
                  {skewed && " ≠ hub"}
                </span>
              )}
              {device.auth === "none" && (
                <Badge variant="secondary">Unauthenticated</Badge>
              )}
            </div>
          )}
          <span className="truncate font-mono text-xs text-muted-foreground">
            {device.tls ? "https://" : ""}{device.host}:{device.port}
          </span>
          {device.username ? (
            <span className="truncate text-xs text-muted-foreground" title={device.username}>
              Team account: {device.username}
            </span>
          ) : teamDevice ? (
            <span className="text-xs text-warning">Team account not configured</span>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Re-test ${device.name}`}
            disabled={busy === "test"}
            onClick={async () => {
              setBusy("test")
              await onTest(device.id)
              setBusy(null)
            }}
          >
            <RefreshCw data-icon="inline-start" className={cn(busy === "test" && "animate-spin")} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Edit account for ${device.name}`}
            onClick={() => {
              setEditingCredentials((value) => !value)
              setCredentialUsername(device.username ?? "")
              setCredentialPassword("")
              setCredentialError(null)
            }}
          >
            <KeyRound data-icon="inline-start" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Rename ${device.name}`}
            onClick={() => setEditing(true)}
          >
            <Pencil data-icon="inline-start" />
          </Button>
          <AlertDialog
            open={removeOpen}
            onOpenChange={(nextOpen) => {
              if (busy !== "remove") setRemoveOpen(nextOpen)
            }}
          >
            <AlertDialogTrigger
              render={(
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${device.name}`}
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                />
              )}
            >
              <Trash2 data-icon="inline-start" />
            </AlertDialogTrigger>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>Remove {device.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This device will disappear from Cogpit. You can add it again later.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy === "remove"}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={busy === "remove"}
                  onClick={async () => {
                    setBusy("remove")
                    try {
                      await onRemove(device.id)
                    } finally {
                      setBusy(null)
                    }
                  }}
                >
                  {busy === "remove" && <Loader2 data-icon="inline-start" className="animate-spin" />}
                  Remove device
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {editingCredentials && (
        <div className="flex flex-col gap-3 border-t px-3 py-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`device-username-${device.id}`}>
                Username <span className="text-muted-foreground/60">(team devices)</span>
              </FieldLabel>
              <Input
                id={`device-username-${device.id}`}
                aria-label={`Username for ${device.name}`}
                value={credentialUsername}
                onChange={(event) => setCredentialUsername(event.target.value)}
                placeholder="Leave empty for password-only auth"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`device-password-${device.id}`}>
                New password <span className="text-muted-foreground/60">(optional)</span>
              </FieldLabel>
              <Input
                id={`device-password-${device.id}`}
                aria-label={`New password for ${device.name}`}
                type="password"
                value={credentialPassword}
                onChange={(event) => setCredentialPassword(event.target.value)}
                placeholder="Leave blank to keep the stored password"
                autoComplete="new-password"
              />
            </Field>
          </div>
          {device.username && credentialUsername.trim() === "" && (
            <p className="text-xs text-warning">
              Clearing the username switches this device back to password-only authentication.
            </p>
          )}
          {credentialError && <FieldError>{credentialError}</FieldError>}
          <div className="flex justify-end gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditingCredentials(false)
                setCredentialUsername(device.username ?? "")
                setCredentialPassword("")
                setCredentialError(null)
              }}
            >
              Cancel
            </Button>
            <Button size="sm" disabled={busy === "credentials"} onClick={() => void saveCredentials()}>
              {busy === "credentials" ? <Loader2 data-icon="inline-start" className="animate-spin" /> : "Save account"}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Dialog ───────────────────────────────────────────────────────────────────

export function DevicesDialog({ open, initialMode, onClose, onCloseComplete }: DevicesDialogProps) {
  const { devices, refresh, probe, addDevice, updateDevice, removeDevice, testDevice } = useDevices()

  const [name, setName] = useState("")
  const [hostInput, setHostInput] = useState("")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [allowLocalTunnel, setAllowLocalTunnel] = useState(false)
  const [probing, setProbing] = useState(false)
  const [probeState, setProbeState] = useState<ProbeDisplayState | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<{ field: "host" | "username" | "password"; message: string } | null>(null)

  const hostRef = useRef<HTMLInputElement>(null)
  const probeSeq = useRef(0)

  // Reset the form each time the dialog opens; focus the host field in add mode.
  useEffect(() => {
    if (!open) return
    setName("")
    setHostInput("")
    setUsername("")
    setPassword("")
    setAllowLocalTunnel(false)
    setProbing(false)
    setProbeState(null)
    setSubmitError(null)
    if (initialMode === "add") {
      requestAnimationFrame(() => hostRef.current?.focus())
    }
  }, [open, initialMode])

  const runProbe = useCallback(async () => {
    const { host, port, tls } = parseHostPort(hostInput)
    if (!host) {
      setProbeState(null)
      setProbing(false)
      return
    }
    const seq = ++probeSeq.current
    setProbing(true)
    const result = await probe(host, port, allowLocalTunnel, tls)
    if (seq !== probeSeq.current) return // a newer probe superseded this one
    setProbeState({
      ...probeMessage(result, host, port ?? (tls ? DEFAULT_TLS_PORT : DEFAULT_PORT)),
      hello: result.ok ? result.hello : undefined,
    })
    setProbing(false)
  }, [hostInput, probe, allowLocalTunnel])

  // Debounced live probe as the host is typed.
  useEffect(() => {
    if (!open) return
    if (!parseHostPort(hostInput).host) {
      setProbeState(null)
      setProbing(false)
      return
    }
    const timer = window.setTimeout(() => void runProbe(), PROBE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [open, hostInput, runProbe])

  const targetIsTeam = probeState?.hello?.edition === "team"
  const targetNeedsBootstrap = targetIsTeam && probeState?.hello?.needsBootstrap === true
  const credentialsRequired = targetIsTeam || !allowLocalTunnel

  const canSubmit = useMemo(() => {
    if (submitting) return false
    if (!parseHostPort(hostInput).host) return false
    if (probing || !probeState) return false
    if (targetNeedsBootstrap) return false
    if (credentialsRequired && !password) return false
    if (targetIsTeam && !username.trim()) return false
    if (probeState?.tone === "error") return false
    return true
  }, [submitting, hostInput, probing, probeState, targetNeedsBootstrap, credentialsRequired, targetIsTeam, username, password])

  async function handleSubmit() {
    const { host, port, tls } = parseHostPort(hostInput)
    if (!host) return
    setSubmitting(true)
    setSubmitError(null)
    const result = await addDevice({
      name: name.trim() || undefined,
      host,
      port,
      tls,
      username: targetIsTeam ? username.trim() : undefined,
      password: credentialsRequired ? password || undefined : undefined,
      allowLocalTunnel,
    })
    setSubmitting(false)
    if (result.ok) {
      onClose()
      switchDevice(result.device.id)
      return
    }
    setSubmitError({
      field: USERNAME_CODES.has(result.code)
        ? "username"
        : PASSWORD_CODES.has(result.code) ? "password" : "host",
      message: result.error,
    })
  }

  const handleRename = useCallback(
    async (id: string, next: string) => {
      await updateDevice(id, { name: next })
    },
    [updateDevice],
  )
  const handleRemove = useCallback(
    async (id: string) => {
      await removeDevice(id)
    },
    [removeDevice],
  )
  const handleTest = useCallback(
    async (id: string) => {
      await testDevice(id)
      await refresh()
    },
    [testDevice, refresh],
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose() }}
      onOpenChangeComplete={(next) => { if (!next) onCloseComplete?.() }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Devices</DialogTitle>
          <DialogDescription>
            Control another Cogpit device from here. The active device is chosen from the header
            switcher — {SWITCH_TIP} jumps between devices.
          </DialogDescription>
        </DialogHeader>

        {devices.length > 0 && (
          <div className="flex flex-col gap-2">
            {devices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                hubVersion={HUB_VERSION}
                onRename={handleRename}
                onCredentials={updateDevice}
                onRemove={handleRemove}
                onTest={handleTest}
              />
            ))}
          </div>
        )}

        <div className="flex flex-col gap-4 border-t pt-4">
          <div className="flex items-center gap-2">
            <Plus data-icon="inline-start" className="size-4 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">Add a device</p>
          </div>

          <FieldGroup>
            <Field data-invalid={submitError?.field === "host"}>
              <FieldLabel htmlFor="device-host">Host</FieldLabel>
              <FieldDescription>Enter a local address or an HTTPS URL.</FieldDescription>
              <Input
                id="device-host"
                ref={hostRef}
                value={hostInput}
                onChange={(event) => {
                  probeSeq.current += 1
                  setHostInput(event.target.value)
                  setUsername("")
                  setProbeState(null)
                  setSubmitError(null)
                }}
                onBlur={() => void runProbe()}
                placeholder="192.168.1.42, my-mac.local:19384 or https://cogpit.example.com"
                spellCheck={false}
                autoComplete="off"
              />
              {probing && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 data-icon="inline-start" className="size-3.5 animate-spin" /> Checking device…
                </p>
              )}
              {!probing && probeState && (
                <p role="status" className={cn("flex items-center gap-1.5 text-xs", TONE_CLASS[probeState.tone])}>
                  <ToneIcon tone={probeState.tone} />
                  {probeState.text}
                </p>
              )}
              {submitError?.field === "host" && (
                <FieldError>{submitError.message}</FieldError>
              )}
            </Field>

            <Field>
              <FieldLabel htmlFor="device-name">
                Name <span className="text-muted-foreground/60">(optional)</span>
              </FieldLabel>
              <Input
                id="device-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Defaults to the device's own name"
              />
            </Field>

            {targetIsTeam && (
              <Field data-invalid={submitError?.field === "username"}>
                <FieldLabel htmlFor="device-username">Username</FieldLabel>
                <Input
                  id="device-username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="Team account username"
                  autoComplete="username"
                  spellCheck={false}
                />
                <FieldDescription>
                  Requests through this hub will act as this account on the team server.
                </FieldDescription>
                {submitError?.field === "username" && (
                  <FieldError>{submitError.message}</FieldError>
                )}
              </Field>
            )}

            {credentialsRequired && (
              <Field data-invalid={submitError?.field === "password"}>
                <FieldLabel htmlFor="device-password">Password</FieldLabel>
                <Input
                  id="device-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={targetIsTeam ? "Password for that team account" : "Network access password for that device"}
                  autoComplete={targetIsTeam ? "current-password" : "off"}
                />
                {submitError?.field === "password" && (
                  <FieldError>{submitError.message}</FieldError>
                )}
              </Field>
            )}
          </FieldGroup>

          <Field orientation="horizontal">
            <Checkbox
              id="device-local-tunnel"
              name="device-local-tunnel"
              checked={allowLocalTunnel}
              onCheckedChange={(checked) => {
                probeSeq.current += 1
                setAllowLocalTunnel(checked === true)
                setProbeState(null)
                setSubmitError(null)
              }}
            />
            <FieldLabel htmlFor="device-local-tunnel">
              This is a local tunnel{targetIsTeam ? "" : " — no password"}
            </FieldLabel>
          </Field>
          {allowLocalTunnel && (
            <Alert className="border-warning/40 bg-warning/10 text-warning">
              <ShieldAlert />
              <AlertDescription className="text-warning">
                {targetIsTeam ? (
                  <>The loopback address is allowed because the tunnel is local; team account authentication still applies.</>
                ) : (
                  <>Traffic to this device is forwarded <strong>unauthenticated</strong>. Only use this for an SSH tunnel or another already-secured local channel.</>
                )}
              </AlertDescription>
            </Alert>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button disabled={!canSubmit} onClick={() => void handleSubmit()}>
              {submitting ? (
                <>
                  <Loader2 data-icon="inline-start" className="size-4 animate-spin" /> Adding…
                </>
              ) : (
                "Add device"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
