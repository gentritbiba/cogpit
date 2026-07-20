import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ExternalLink,
  Globe2,
  Maximize2,
  Monitor,
  RefreshCw,
  Server,
  Smartphone,
  Tablet,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { authFetch } from "@/lib/auth"
import { deviceScopedKey } from "@/lib/device"
import { matchesKeybinding } from "@/lib/keybindings"
import { cn } from "@/lib/utils"
import { useDevices } from "@/hooks/useDevices"

interface PreviewTask {
  id: string
  ports: number[]
  portStatus: Record<number, boolean>
  preview: string
}

interface PreviewPanelProps {
  cwd: string
  onClose: () => void
}

const MIN_WIDTH = 360
const DEFAULT_WIDTH = 560
const WIDTH_KEY = "cogpit-preview-width"
const VIEWPORT_KEY = "cogpit-preview-viewport"
const ZOOM_KEY = "cogpit-preview-zoom"
const MIN_ZOOM = 0.5
const MAX_ZOOM = 1.5
const ZOOM_STEP = 0.1

const VIEWPORTS = {
  responsive: { label: "Responsive", width: null, height: null, icon: Maximize2 },
  phone: { label: "Phone", width: 390, height: 844, icon: Smartphone },
  tablet: { label: "Tablet", width: 768, height: 1024, icon: Tablet },
  desktop: { label: "Desktop", width: 1280, height: 800, icon: Monitor },
} as const

type PreviewViewport = keyof typeof VIEWPORTS

function loadWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY))
    if (Number.isFinite(stored) && stored >= MIN_WIDTH) return stored
  } catch {
    // Use the default when storage is unavailable.
  }
  return DEFAULT_WIDTH
}

function loadViewport(): PreviewViewport {
  try {
    const stored = localStorage.getItem(VIEWPORT_KEY)
    if (stored && stored in VIEWPORTS) return stored as PreviewViewport
  } catch {
    // Use responsive mode when storage is unavailable.
  }
  return "responsive"
}

function loadZoom(): number {
  try {
    const raw = localStorage.getItem(ZOOM_KEY)
    if (raw === null) return 1
    const stored = Number(raw)
    if (Number.isFinite(stored)) return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, stored))
  } catch {
    // Use 100% when storage is unavailable.
  }
  return 1
}

function projectUrlKey(cwd: string): string {
  // Device-scoped so each device remembers its own preview URL for a project.
  return deviceScopedKey(`cogpit-preview-url:${cwd}`)
}

export function normalizePreviewUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const hasNonWebScheme = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
    && !/^https?:\/\//i.test(trimmed)
    && !/^[^/]+:\d+(?:\/|$)/.test(trimmed)
  if (hasNonWebScheme) return null
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
    return parsed.href
  } catch {
    return null
  }
}

function urlForPort(port: number, host: string): string {
  return `http://${host || "localhost"}:${port}/`
}

export function PreviewPanel({ cwd, onClose }: PreviewPanelProps) {
  const [tasks, setTasks] = useState<PreviewTask[]>([])
  const [url, setUrl] = useState("")
  const [draft, setDraft] = useState("")
  const [urlError, setUrlError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [loading, setLoading] = useState(false)
  const [width, setWidth] = useState(loadWidth)
  const [viewport, setViewport] = useState<PreviewViewport>(loadViewport)
  const [zoom, setZoom] = useState(loadZoom)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const panelRef = useRef<HTMLElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)

  // When a remote device is active, detected servers run on that device's host;
  // otherwise fall back to the current (local) origin.
  const { activeDevice } = useDevices()
  const previewHost = activeDevice?.host ?? (window.location.hostname || "localhost")
  const activeDeviceId = activeDevice?.id

  // Restore the persisted URL for the current device + project. Depends on the
  // active device so a switch (which changes the scoped storage key) re-reads
  // under the right key. We reset url/draft to the newly-restored value up front
  // so a stale URL from the previous device can't survive the switch — including
  // being picked up by the port-discovery effect's `current || discovered`.
  useEffect(() => {
    let stored = ""
    try {
      stored = localStorage.getItem(projectUrlKey(cwd)) ?? ""
    } catch {
      // Start empty when storage is unavailable.
    }
    const validated = stored ? normalizePreviewUrl(stored) ?? "" : ""
    setUrl(validated)
    setDraft(validated)
    setUrlError(null)
  }, [cwd, activeDeviceId])

  useEffect(() => {
    let cancelled = false
    async function loadServers() {
      try {
        const response = await authFetch(`/api/background-tasks?cwd=${encodeURIComponent(cwd)}`)
        if (cancelled || !response.ok) return
        const data: unknown = await response.json()
        const nextTasks = Array.isArray(data) ? data as PreviewTask[] : []
        setTasks(nextTasks)
        const firstPort = nextTasks
          .flatMap((task) => task.ports.filter((port) => task.portStatus[port]))
          .at(0)
        if (firstPort) {
          const discoveredUrl = urlForPort(firstPort, previewHost)
          setUrl((current) => current || discoveredUrl)
          setDraft((current) => current || discoveredUrl)
        }
      } catch {
        if (!cancelled) setTasks([])
      }
    }
    void loadServers()
    const interval = window.setInterval(loadServers, 10_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [cwd, previewHost])

  useEffect(() => {
    if (!url) return
    try {
      localStorage.setItem(projectUrlKey(cwd), url)
    } catch {
      // Preview remains usable without persistence.
    }
  }, [cwd, url])

  useEffect(() => {
    try {
      localStorage.setItem(VIEWPORT_KEY, viewport)
      localStorage.setItem(ZOOM_KEY, String(zoom))
    } catch {
      // Preview controls remain usable without persistence.
    }
  }, [viewport, zoom])

  const activePorts = useMemo(() =>
    [...new Set(tasks.flatMap((task) => task.ports.filter((port) => task.portStatus[port])))].sort((a, b) => a - b),
  [tasks])

  const navigate = useCallback((nextValue: string) => {
    const normalized = normalizePreviewUrl(nextValue)
    if (!normalized) {
      setUrlError("Enter a valid HTTP or HTTPS URL.")
      return
    }
    setUrlError(null)
    setUrl(normalized)
    setDraft(normalized)
    setLoading(true)
  }, [])

  const refresh = useCallback(() => {
    if (!url) return
    setLoading(true)
    setReloadKey((key) => key + 1)
  }, [url])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!panelRef.current?.contains(document.activeElement)) return
      if (matchesKeybinding("previewRefresh", event)) {
        event.preventDefault()
        refresh()
        return
      }
      if (matchesKeybinding("previewFocusUrl", event)) {
        event.preventDefault()
        urlInputRef.current?.focus()
        urlInputRef.current?.select()
        return
      }
      if (matchesKeybinding("previewZoomIn", event)) {
        event.preventDefault()
        setZoom((current) => Math.min(MAX_ZOOM, Number((current + ZOOM_STEP).toFixed(1))))
        return
      }
      if (matchesKeybinding("previewZoomOut", event)) {
        event.preventDefault()
        setZoom((current) => Math.max(MIN_ZOOM, Number((current - ZOOM_STEP).toFixed(1))))
        return
      }
      if (matchesKeybinding("previewResetZoom", event)) {
        event.preventDefault()
        setZoom(1)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [refresh])

  const handlePointerDown = useCallback((event: React.PointerEvent) => {
    event.preventDefault()
    dragRef.current = { startX: event.clientX, startWidth: width }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }, [width])

  const handlePointerMove = useCallback((event: React.PointerEvent) => {
    if (!dragRef.current) return
    const maxWidth = Math.max(MIN_WIDTH, window.innerWidth * 0.7)
    const next = dragRef.current.startWidth + (dragRef.current.startX - event.clientX)
    setWidth(Math.min(maxWidth, Math.max(MIN_WIDTH, next)))
  }, [])

  const handlePointerUp = useCallback(() => {
    if (!dragRef.current) return
    dragRef.current = null
    setWidth((current) => {
      try {
        localStorage.setItem(WIDTH_KEY, String(current))
      } catch {
        // Ignore persistence failures.
      }
      return current
    })
  }, [])

  return (
    <aside
      ref={panelRef}
      aria-label="Development preview"
      className="relative flex min-h-0 shrink-0 flex-col border-l border-border bg-elevation-0"
      style={{ width }}
    >
      <div
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-1 cursor-col-resize hover:bg-primary/30"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />

      <div className="flex h-10 shrink-0 items-center gap-2 px-3">
        <Globe2 aria-hidden="true" className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Preview</h2>
        <span className="flex-1" />
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close preview">
          <X data-icon="inline-start" />
        </Button>
      </div>

      <Separator />

      <form
        className="flex items-center gap-1.5 p-2"
        onSubmit={(event) => {
          event.preventDefault()
          navigate(draft)
        }}
      >
        <Input
          ref={urlInputRef}
          aria-label="Preview URL"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="localhost:3000"
          spellCheck={false}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          disabled={!url}
          onClick={refresh}
          aria-label="Refresh preview"
        >
          <RefreshCw data-icon="inline-start" className={loading ? "animate-spin" : undefined} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          disabled={!url}
          onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
          aria-label="Open preview in browser"
        >
          <ExternalLink data-icon="inline-start" />
        </Button>
      </form>

      {urlError && <p role="alert" className="px-3 pb-2 text-xs text-destructive">{urlError}</p>}

      {activePorts.length > 0 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto px-2 pb-2">
          <Server aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          {activePorts.map((port) => (
            <Button
              key={port}
              variant="outline"
              size="sm"
              className="h-6 px-2 font-mono text-[10px]"
              onClick={() => navigate(urlForPort(port, previewHost))}
              aria-label={`Open localhost:${port} preview`}
            >
              :{port}
            </Button>
          ))}
        </div>
      )}

      <div className="flex shrink-0 items-center justify-between gap-2 px-2 pb-2">
        <ToggleGroup
          aria-label="Preview viewport"
          value={[viewport]}
          onValueChange={(values) => {
            const next = values[0]
            if (next && next in VIEWPORTS) setViewport(next as PreviewViewport)
          }}
          variant="outline"
          size="sm"
          spacing={0}
        >
          {(Object.entries(VIEWPORTS) as Array<[PreviewViewport, typeof VIEWPORTS[PreviewViewport]]>).map(
            ([value, option]) => {
              const Icon = option.icon
              return (
                <ToggleGroupItem
                  key={value}
                  value={value}
                  aria-label={`${option.label} viewport`}
                  title={option.width ? `${option.label} · ${option.width}×${option.height}` : option.label}
                >
                  <Icon />
                </ToggleGroupItem>
              )
            },
          )}
        </ToggleGroup>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setZoom((current) => Math.max(MIN_ZOOM, Number((current - ZOOM_STEP).toFixed(1))))}
            aria-label="Zoom preview out"
            title="Zoom out"
          >
            <ZoomOut data-icon="inline-start" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setZoom(1)} aria-label="Reset preview zoom">
            {Math.round(zoom * 100)}%
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setZoom((current) => Math.min(MAX_ZOOM, Number((current + ZOOM_STEP).toFixed(1))))}
            aria-label="Zoom preview in"
            title="Zoom in"
          >
            <ZoomIn data-icon="inline-start" />
          </Button>
        </div>
      </div>

      <Separator />

      <div className="min-h-0 flex-1 overflow-auto bg-muted/30 p-3">
        {url ? (
          <div
            className={cn(
              "relative mx-auto overflow-hidden bg-white shadow-sm",
              viewport === "responsive" && "size-full",
            )}
            style={viewport === "responsive" ? undefined : {
              width: VIEWPORTS[viewport].width * zoom,
              height: VIEWPORTS[viewport].height * zoom,
            }}
          >
            <iframe
              key={`${url}-${reloadKey}`}
              title="Development preview"
              src={url}
              className="block border-0 bg-white"
              style={viewport === "responsive" ? {
                width: `${100 / zoom}%`,
                height: `${100 / zoom}%`,
                transform: `scale(${zoom})`,
                transformOrigin: "top left",
              } : {
                width: VIEWPORTS[viewport].width,
                height: VIEWPORTS[viewport].height,
                transform: `scale(${zoom})`,
                transformOrigin: "top left",
              }}
              sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
              referrerPolicy="no-referrer"
              onLoad={() => setLoading(false)}
            />
          </div>
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 p-8 text-center">
            <Globe2 aria-hidden="true" className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">No preview selected</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Start a local development server or enter its URL above. Detected ports appear automatically.
            </p>
          </div>
        )}
      </div>
    </aside>
  )
}
