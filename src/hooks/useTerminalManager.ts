import { useState, useEffect, useCallback, useRef } from "react"
import type { TerminalSession, ServerMessage } from "@/lib/terminal-types"

export interface TerminalManager {
  sessions: TerminalSession[]
  connected: boolean
  spawn: (opts?: {
    name?: string
    cwd?: string
    cols?: number
    rows?: number
    command?: string
    args?: string[]
  }) => string
  kill: (id: string) => void
  rename: (id: string, name: string) => void
  sendInput: (id: string, data: string) => void
  sendResize: (id: string, cols: number, rows: number) => void
  onOutput: (id: string, callback: (data: string) => void) => () => void
  onExit: (id: string, callback: (code: number) => void) => () => void
}

export function useTerminalManager(): TerminalManager {
  const wsRef = useRef<WebSocket | null>(null)
  const [sessions, setSessions] = useState<TerminalSession[]>([])
  const [connected, setConnected] = useState(false)

  const outputListeners = useRef(
    new Map<string, Set<(data: string) => void>>()
  )
  const exitListeners = useRef(
    new Map<string, Set<(code: number) => void>>()
  )

  useEffect(() => {
    let retryDelay = 1000
    let closed = false
    let ws: WebSocket

    function connect() {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:"
      ws = new WebSocket(`${protocol}//${location.host}/__pty`)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        retryDelay = 1000
        ws.send(JSON.stringify({ type: "list" }))
      }

      ws.onmessage = (event) => {
        const msg: ServerMessage = JSON.parse(event.data)
        handleServerMessage(msg)
      }

      ws.onclose = () => {
        setConnected(false)
        wsRef.current = null
        if (!closed) {
          setTimeout(connect, retryDelay)
          retryDelay = Math.min(retryDelay * 2, 10_000)
        }
      }

      ws.onerror = () => {
        // onclose will fire after this
      }
    }

    function handleServerMessage(msg: ServerMessage) {
      switch (msg.type) {
        case "output": {
          const listeners = outputListeners.current.get(msg.id)
          if (listeners) {
            for (const cb of listeners) cb(msg.data)
          }
          break
        }
        case "exit": {
          setSessions((prev) =>
            prev.map((s) =>
              s.id === msg.id
                ? { ...s, status: "exited" as const, exitCode: msg.code }
                : s
            )
          )
          const listeners = exitListeners.current.get(msg.id)
          if (listeners) {
            for (const cb of listeners) cb(msg.code)
          }
          break
        }
        case "sessions": {
          setSessions(msg.sessions)
          break
        }
        case "session_update": {
          setSessions((prev) => {
            const idx = prev.findIndex((s) => s.id === msg.session.id)
            if (idx >= 0) {
              const next = [...prev]
              next[idx] = msg.session
              return next
            }
            return [...prev, msg.session]
          })
          break
        }
        case "error": {
          console.error(`Terminal ${msg.id}: ${msg.message}`)
          break
        }
      }
    }

    connect()
    return () => {
      closed = true
      ws?.close()
    }
  }, [])

  const send = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  const spawn = useCallback(
    (opts?: {
      name?: string
      cwd?: string
      cols?: number
      rows?: number
      command?: string
      args?: string[]
    }): string => {
      const id = crypto.randomUUID()
      send({
        type: "spawn",
        id,
        cols: opts?.cols ?? 80,
        rows: opts?.rows ?? 24,
        name: opts?.name,
        cwd: opts?.cwd,
        command: opts?.command,
        args: opts?.args,
      })
      return id
    },
    [send]
  )

  const kill = useCallback((id: string) => send({ type: "kill", id }), [send])

  const rename = useCallback(
    (id: string, name: string) => send({ type: "rename", id, name }),
    [send]
  )

  const sendInput = useCallback(
    (id: string, data: string) => send({ type: "input", id, data }),
    [send]
  )

  const sendResize = useCallback(
    (id: string, cols: number, rows: number) =>
      send({ type: "resize", id, cols, rows }),
    [send]
  )

  const onOutput = useCallback(
    (id: string, callback: (data: string) => void) => {
      if (!outputListeners.current.has(id))
        outputListeners.current.set(id, new Set())
      outputListeners.current.get(id)!.add(callback)
      send({ type: "attach", id })
      return () => {
        outputListeners.current.get(id)?.delete(callback)
      }
    },
    [send]
  )

  const onExit = useCallback(
    (id: string, callback: (code: number) => void) => {
      if (!exitListeners.current.has(id))
        exitListeners.current.set(id, new Set())
      exitListeners.current.get(id)!.add(callback)
      return () => {
        exitListeners.current.get(id)?.delete(callback)
      }
    },
    []
  )

  return {
    sessions,
    connected,
    spawn,
    kill,
    rename,
    sendInput,
    sendResize,
    onOutput,
    onExit,
  }
}
