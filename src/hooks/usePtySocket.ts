import { useState, useRef, useEffect, useCallback } from "react"
import { devicePrefix } from "@/lib/device"
import type { CodeModeLaunch } from "@/lib/agents/codeMode"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PtySessionInfo {
  id: string
  name: string
  status: "running" | "exited"
  exitCode: number | null
  createdAt: number
  cwd: string
  metadata?: {
    type: "script" | "terminal"
    source?: string
    scriptName?: string
    /** The Cogpit session a Code Mode terminal runs, stamped by the server that launched it. */
    sessionId?: string
  }
}

export type PtyConnectionStatus = "connecting" | "connected" | "disconnected"

type SessionHandler = (type: string, data: unknown) => void

// ── Constants ─────────────────────────────────────────────────────────────────

const INITIAL_RECONNECT_DELAY = 500
const MAX_RECONNECT_DELAY = 5000

// ── Hook ──────────────────────────────────────────────────────────────────────

export function usePtySocket(enabled = true) {
  const [status, setStatus] = useState<PtyConnectionStatus>("disconnected")
  const [sessions, setSessions] = useState<PtySessionInfo[]>([])
  /** The terminal list has come in on the current connection, so it is not one left from before. */
  const [listed, setListed] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const subscribersRef = useRef<Map<string, SessionHandler>>(new Map())
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unmountedRef = useRef(false)

  const connectRef = useRef<() => void>(() => {})

  const handleMessage = useCallback((msg: Record<string, unknown>) => {
    const type = msg.type as string
    const id = msg.id as string | undefined

    if (type === "sessions") {
      setSessions((msg.sessions as PtySessionInfo[]) ?? [])
      setListed(true)
      return
    }

    if (id) {
      subscribersRef.current.get(id)?.(type, msg)
    }
  }, [])

  useEffect(() => {
    unmountedRef.current = false

    if (!enabled) return () => {
      unmountedRef.current = true
    }

    function buildWsUrl() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
      // devicePrefix() routes the socket to a remote device via the hub proxy
      // ("/hub/<id>/__pty"); "" for the local device. On a device switch, App
      // remounts (DeviceRoot key) which unmounts this hook and tears the socket
      // down — no in-place reconnect logic needed here.
      return `${protocol}//${window.location.host}${devicePrefix()}/__pty`
    }

    function connect() {
      if (unmountedRef.current) return
      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) return

      setStatus("connecting")
      setListed(false)
      const ws = new WebSocket(buildWsUrl())
      wsRef.current = ws

      ws.onopen = () => {
        if (unmountedRef.current) { ws.close(); return }
        reconnectDelayRef.current = INITIAL_RECONNECT_DELAY
        setStatus("connected")
        ws.send(JSON.stringify({ type: "list" }))
      }

      ws.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string) as Record<string, unknown>
          handleMessage(msg)
        } catch {
          // ignore malformed messages
        }
      }

      ws.onclose = () => {
        if (unmountedRef.current) return
        setStatus("disconnected")
        setListed(false)
        wsRef.current = null
        const delay = reconnectDelayRef.current
        reconnectDelayRef.current = Math.min(delay * 2, MAX_RECONNECT_DELAY)
        reconnectTimerRef.current = setTimeout(() => connectRef.current(), delay)
      }
    }

    connectRef.current = connect
    connect()

    return () => {
      unmountedRef.current = true
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [enabled, handleMessage])

  const send = useCallback((msg: object) => {
    if (!enabled) return
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }, [enabled])

  const subscribe = useCallback((sessionId: string, handler: SessionHandler) => {
    subscribersRef.current.set(sessionId, handler)
  }, [])

  const unsubscribe = useCallback((sessionId: string) => {
    subscribersRef.current.delete(sessionId)
  }, [])

  /**
   * A shell, an agent's sign-in, or a session in an agent's Code Mode. The
   * server builds the last two from the agent, account and session they name.
   */
  const spawnTerminal = useCallback((opts: {
    name?: string
    cwd?: string
    signIn?: { agent: string; instanceId: string | null }
    codeMode?: Omit<CodeModeLaunch, "kind" | "cwd"> & { agent: string }
  } = {}) => {
    const id = `pty_${crypto.randomUUID().slice(0, 8)}`
    send({
      type: "spawn",
      id,
      name: opts.name ?? "Terminal",
      cwd: opts.cwd,
      ...(opts.signIn ? { signIn: opts.signIn } : {}),
      ...(opts.codeMode ? { codeMode: opts.codeMode } : {}),
      // The server ties a Code Mode terminal to its session; a client cannot.
      metadata: { type: "terminal" },
    })
    return id
  }, [send])

  const spawnScript = useCallback((opts: {
    name: string
    cwd: string
    source: string
    scriptName: string
  }) => {
    const id = `script_${crypto.randomUUID().slice(0, 8)}`
    send({
      type: "spawn",
      id,
      name: opts.name,
      cwd: opts.cwd,
      args: ["run", opts.scriptName],
      command: "bun",
      metadata: {
        type: "script",
        source: opts.source,
        scriptName: opts.scriptName,
      },
    })
    return id
  }, [send])

  const killSession = useCallback((id: string) => {
    send({ type: "kill", id })
  }, [send])

  const writeInput = useCallback((id: string, data: string) => {
    send({ type: "input", id, data })
  }, [send])

  const resize = useCallback((id: string, cols: number, rows: number) => {
    send({ type: "resize", id, cols, rows })
  }, [send])

  return {
    status,
    listed,
    send,
    subscribe,
    unsubscribe,
    sessions,
    spawnTerminal,
    spawnScript,
    killSession,
    writeInput,
    resize,
  }
}
