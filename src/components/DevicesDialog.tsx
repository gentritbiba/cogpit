import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
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
import { cn } from "@/lib/utils"
import { switchDevice } from "@/lib/device"
import {
  deviceVersion,
  useDevices,
  type ProbeResult,
  type PublicDevice,
} from "@/hooks/useDevices"
import packageJson from "../../package.json"

const HUB_VERSION = packageJson.version
const DEFAULT_PORT = 19384
const PROBE_DEBOUNCE_MS = 450

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || "")
const SWITCH_TIP = `${IS_MAC ? "⌘⇧" : "Ctrl+Shift+"}1–9`

// Which field an add-error code belongs under.
const PASSWORD_CODES = new Set(["BAD_PASSWORD", "PASSWORD_REQUIRED"])

interface DevicesDialogProps {
  open: boolean
  initialMode: "add" | "manage"
  onClose: () => void
}

/** Split a "host" or "host:port" entry (tolerating a pasted http(s):// prefix). */
export function parseHostPort(input: string): { host: string; port?: number } {
  const noScheme = input.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
  const match = /^(.+):(\d+)$/.exec(noScheme)
  if (match) return { host: match[1], port: Number(match[2]) }
  return { host: noScheme }
}

type ProbeTone = "ok" | "warn" | "info" | "error"

/** Turn a probe result into actionable, human copy. */
export function probeMessage(
  result: ProbeResult,
  host: string,
  port: number,
): { tone: ProbeTone; text: string } {
  if (result.ok) {
    if (result.hello.networkAccess === false) {
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
  ok: "text-green-400",
  warn: "text-amber-400",
  info: "text-blue-400",
  error: "text-red-400",
}

function ToneIcon({ tone }: { tone: ProbeTone }) {
  const className = cn("size-3.5 shrink-0", TONE_CLASS[tone])
  if (tone === "ok") return <CheckCircle2 className={className} />
  if (tone === "warn") return <AlertTriangle className={className} />
  if (tone === "info") return <RefreshCw className={className} />
  return <XCircle className={className} />
}

// ── Existing-device row ──────────────────────────────────────────────────────

const AUTH_STATE_DOT: Record<PublicDevice["runtime"]["authState"], string> = {
  ok: "bg-green-500",
  unknown: "bg-amber-500",
  "bad-password": "bg-red-500",
}

interface DeviceRowProps {
  device: PublicDevice
  hubVersion: string
  onRename: (id: string, name: string) => Promise<void>
  onRemove: (id: string) => Promise<void>
  onTest: (id: string) => Promise<void>
}

function DeviceRow({ device, hubVersion, onRename, onRemove, onTest }: DeviceRowProps) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(device.name)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [busy, setBusy] = useState<null | "rename" | "remove" | "test">(null)

  useEffect(() => {
    setName(device.name)
  }, [device.name])

  const version = deviceVersion(device)
  const skewed = version !== undefined && version !== hubVersion

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

  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border bg-elevation-0 px-3 py-2">
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
                className={cn("shrink-0 font-mono text-[10px]", skewed ? "text-amber-400" : "text-muted-foreground/60")}
                title={skewed ? `Device runs v${version}; hub runs v${hubVersion}` : undefined}
              >
                v{version}
                {skewed && " ≠ hub"}
              </span>
            )}
            {device.auth === "none" && (
              <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                unauthenticated
              </span>
            )}
          </div>
        )}
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {device.host}:{device.port}
        </span>
      </div>

      {confirmRemove ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-red-400 hover:text-red-300"
            disabled={busy === "remove"}
            onClick={async () => {
              setBusy("remove")
              await onRemove(device.id)
              setBusy(null)
            }}
          >
            {busy === "remove" ? <Loader2 className="size-3.5 animate-spin" /> : "Confirm"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={() => setConfirmRemove(false)}
          >
            Cancel
          </Button>
        </div>
      ) : (
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
            <RefreshCw className={cn("size-3.5", busy === "test" && "animate-spin")} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Rename ${device.name}`}
            onClick={() => setEditing(true)}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${device.name}`}
            className="text-muted-foreground hover:text-red-400"
            onClick={() => setConfirmRemove(true)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  )
}

// ── Dialog ───────────────────────────────────────────────────────────────────

export function DevicesDialog({ open, initialMode, onClose }: DevicesDialogProps) {
  const { devices, refresh, probe, addDevice, updateDevice, removeDevice, testDevice } = useDevices()

  const [name, setName] = useState("")
  const [hostInput, setHostInput] = useState("")
  const [password, setPassword] = useState("")
  const [allowLocalTunnel, setAllowLocalTunnel] = useState(false)
  const [probing, setProbing] = useState(false)
  const [probeState, setProbeState] = useState<{ tone: ProbeTone; text: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<{ field: "host" | "password"; message: string } | null>(null)

  const hostRef = useRef<HTMLInputElement>(null)
  const probeSeq = useRef(0)

  // Reset the form each time the dialog opens; focus the host field in add mode.
  useEffect(() => {
    if (!open) return
    setName("")
    setHostInput("")
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
    const { host, port } = parseHostPort(hostInput)
    if (!host) {
      setProbeState(null)
      setProbing(false)
      return
    }
    const seq = ++probeSeq.current
    setProbing(true)
    const result = await probe(host, port, allowLocalTunnel)
    if (seq !== probeSeq.current) return // a newer probe superseded this one
    setProbeState(probeMessage(result, host, port ?? DEFAULT_PORT))
    setProbing(false)
  }, [hostInput, probe, allowLocalTunnel])

  // Debounced live probe as the host is typed.
  useEffect(() => {
    if (!open) return
    if (!parseHostPort(hostInput).host) {
      setProbeState(null)
      return
    }
    const timer = window.setTimeout(() => void runProbe(), PROBE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [open, hostInput, runProbe])

  const canSubmit = useMemo(() => {
    if (submitting) return false
    if (!parseHostPort(hostInput).host) return false
    if (!allowLocalTunnel && !password) return false
    if (probeState?.tone === "error") return false
    return true
  }, [submitting, hostInput, allowLocalTunnel, password, probeState])

  async function handleSubmit() {
    const { host, port } = parseHostPort(hostInput)
    if (!host) return
    setSubmitting(true)
    setSubmitError(null)
    const result = await addDevice({
      name: name.trim() || undefined,
      host,
      port,
      password: allowLocalTunnel ? undefined : password || undefined,
      allowLocalTunnel,
    })
    setSubmitting(false)
    if (result.ok) {
      onClose()
      switchDevice(result.device.id)
      return
    }
    setSubmitError({
      field: PASSWORD_CODES.has(result.code) ? "password" : "host",
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
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Devices</DialogTitle>
          <DialogDescription>
            Control another Cogpit device from here. The active device is chosen from the header
            switcher — {SWITCH_TIP} jumps between devices.
          </DialogDescription>
        </DialogHeader>

        {/* Existing devices */}
        {devices.length > 0 && (
          <div className="space-y-1.5">
            {devices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                hubVersion={HUB_VERSION}
                onRename={handleRename}
                onRemove={handleRemove}
                onTest={handleTest}
              />
            ))}
          </div>
        )}

        {/* Add device */}
        <div className="space-y-3 border-t border-border pt-4">
          <div className="flex items-center gap-2">
            <Plus className="size-4 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">Add a device</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground" htmlFor="device-host">
              Host
            </label>
            <Input
              id="device-host"
              ref={hostRef}
              value={hostInput}
              onChange={(event) => setHostInput(event.target.value)}
              onBlur={() => void runProbe()}
              placeholder="192.168.1.42 or my-mac.local:19384"
              spellCheck={false}
              autoComplete="off"
            />
            {probing && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Checking device…
              </p>
            )}
            {!probing && probeState && (
              <p role="status" className={cn("flex items-center gap-1.5 text-xs", TONE_CLASS[probeState.tone])}>
                <ToneIcon tone={probeState.tone} />
                {probeState.text}
              </p>
            )}
            {submitError?.field === "host" && (
              <p role="alert" className="text-xs text-red-400">{submitError.message}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground" htmlFor="device-name">
              Name <span className="text-muted-foreground/60">(optional)</span>
            </label>
            <Input
              id="device-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Defaults to the device's own name"
            />
          </div>

          {!allowLocalTunnel && (
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground" htmlFor="device-password">
                Password
              </label>
              <Input
                id="device-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Network access password for that device"
                autoComplete="off"
              />
              {submitError?.field === "password" && (
                <p role="alert" className="text-xs text-red-400">{submitError.message}</p>
              )}
            </div>
          )}

          <label className="flex items-start gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={allowLocalTunnel}
              onChange={(event) => setAllowLocalTunnel(event.target.checked)}
              className="mt-0.5"
            />
            <span>This is a local tunnel — no password</span>
          </label>
          {allowLocalTunnel && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
              <p className="text-[11px] text-amber-300/90">
                Traffic to this device is forwarded <strong>unauthenticated</strong>. Only use this for
                an SSH tunnel or another already-secured local channel.
              </p>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose} className="text-muted-foreground hover:text-foreground">
              Close
            </Button>
            <Button disabled={!canSubmit} onClick={() => void handleSubmit()}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" /> Adding…
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
