import { useState, useRef, useEffect, useCallback } from "react"
import { isRemoteClient, getToken } from "@/lib/auth"

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
  }
}

export type PtyConnectionStatus = "connecting" | "connected" | "disconnected"

type SessionHandler = (type: string, data: unknown) => void

// ── Constants ─────────────────────────────────────────────────────────────────

const INITIAL_RECONNECT_DELAY = 500
const MAX_RECONNECT_DELAY = 5000

// ── Hook ──────────────────────────────────────────────────────────────────────

export function usePtySocket() {
  const [status, setStatus] = useState<PtyConnectionStatus>("disconnected")
  const [sessions, setSessions] = useState<PtySessionInfo[]>([])

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
      return
    }

    if (id) {
      subscribersRef.current.get(id)?.(type, msg)
    }
  }, [])

  useEffect(() => {
    unmountedRef.current = false

    function buildWsUrl() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
      let url = `${protocol}//${window.location.host}/__pty`
      if (isRemoteClient()) {
        const token = getToken()
        if (token) {
          url += `?token=${encodeURIComponent(token)}`
        }
      }
      return url
    }

    function connect() {
      if (unmountedRef.current) return
      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) return

      setStatus("connecting")
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
  }, [handleMessage])

  const send = useCallback((msg: object) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }, [])

  const subscribe = useCallback((sessionId: string, handler: SessionHandler) => {
    subscribersRef.current.set(sessionId, handler)
  }, [])

  const unsubscribe = useCallback((sessionId: string) => {
    subscribersRef.current.delete(sessionId)
  }, [])

  const spawnTerminal = useCallback((opts: { name?: string; cwd?: string } = {}) => {
    const id = `pty_${crypto.randomUUID().slice(0, 8)}`
    send({
      type: "spawn",
      id,
      name: opts.name ?? "Terminal",
      cwd: opts.cwd,
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
