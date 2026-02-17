import type { Plugin, ViteDevServer } from "vite"
import { WebSocketServer, WebSocket } from "ws"
import { spawn as ptySpawn, type IPty } from "node-pty"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"

interface PtySession {
  id: string
  pty: IPty
  name: string
  status: "running" | "exited"
  exitCode: number | null
  cols: number
  rows: number
  scrollback: string
  clients: Set<WebSocket>
  createdAt: number
  cwd: string
}

interface SessionInfo {
  id: string
  name: string
  status: "running" | "exited"
  exitCode: number | null
  createdAt: number
  cwd: string
}

function toSessionInfo(s: PtySession): SessionInfo {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    exitCode: s.exitCode,
    createdAt: s.createdAt,
    cwd: s.cwd,
  }
}

function broadcastToAll(wss: WebSocketServer, msg: object) {
  const data = JSON.stringify(msg)
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data)
    }
  }
}

function sendSessionList(wss: WebSocketServer, sessions: Map<string, PtySession>) {
  broadcastToAll(wss, {
    type: "sessions",
    sessions: Array.from(sessions.values()).map(toSessionInfo),
  })
}

export function ptyPlugin(): Plugin {
  const sessions = new Map<string, PtySession>()
  let wss: WebSocketServer

  return {
    name: "pty-websocket",
    configureServer(server: ViteDevServer) {
      wss = new WebSocketServer({ noServer: true })

      server.httpServer!.on(
        "upgrade",
        (req: IncomingMessage, socket: Duplex, head: Buffer) => {
          const url = new URL(req.url || "/", "http://localhost")
          if (url.pathname !== "/__pty") return

          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req)
          })
        }
      )

      wss.on("connection", (ws: WebSocket) => {
        ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(raw.toString())
            handleMessage(ws, msg)
          } catch {
            ws.send(JSON.stringify({ type: "error", id: "", message: "Invalid JSON" }))
          }
        })

        ws.on("close", () => {
          for (const session of sessions.values()) {
            session.clients.delete(ws)
          }
        })
      })

      function handleMessage(ws: WebSocket, msg: Record<string, unknown>) {
        switch (msg.type) {
          case "spawn":
            handleSpawn(ws, msg)
            break
          case "input":
            handleInput(msg)
            break
          case "resize":
            handleResize(msg)
            break
          case "kill":
            handleKill(msg)
            break
          case "attach":
            handleAttach(ws, msg)
            break
          case "list":
            ws.send(
              JSON.stringify({
                type: "sessions",
                sessions: Array.from(sessions.values()).map(toSessionInfo),
              })
            )
            break
          case "rename":
            handleRename(msg)
            break
        }
      }

      function handleSpawn(ws: WebSocket, msg: Record<string, unknown>) {
        const id = (msg.id as string) || randomUUID()
        const name = (msg.name as string) || `Terminal ${sessions.size + 1}`
        const cwd = (msg.cwd as string) || homedir()
        const cols = (msg.cols as number) || 80
        const rows = (msg.rows as number) || 24
        const command = (msg.command as string) || process.env.SHELL || "/bin/zsh"
        const args = (msg.args as string[]) || []

        let pty: IPty
        try {
          pty = ptySpawn(command, args, {
            name: "xterm-256color",
            cols,
            rows,
            cwd,
            env: { ...process.env, TERM: "xterm-256color" } as Record<
              string,
              string
            >,
          })
        } catch (err) {
          ws.send(
            JSON.stringify({
              type: "error",
              id,
              message: `Failed to spawn PTY: ${err}`,
            })
          )
          return
        }

        const session: PtySession = {
          id,
          pty,
          name,
          status: "running",
          exitCode: null,
          cols,
          rows,
          scrollback: "",
          clients: new Set([ws]),
          createdAt: Date.now(),
          cwd,
        }

        pty.onData((data: string) => {
          session.scrollback += data
          if (session.scrollback.length > 50_000) {
            session.scrollback = session.scrollback.slice(-40_000)
          }
          const out = JSON.stringify({ type: "output", id, data })
          for (const client of session.clients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(out)
            }
          }
        })

        pty.onExit(({ exitCode }: { exitCode: number }) => {
          session.status = "exited"
          session.exitCode = exitCode
          const exitMsg = JSON.stringify({ type: "exit", id, code: exitCode })
          for (const client of session.clients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(exitMsg)
            }
          }
          sendSessionList(wss, sessions)
        })

        sessions.set(id, session)
        ws.send(JSON.stringify({ type: "spawned", id, name }))
        sendSessionList(wss, sessions)
      }

      function handleInput(msg: Record<string, unknown>) {
        const session = sessions.get(msg.id as string)
        if (session?.status === "running") {
          session.pty.write(msg.data as string)
        }
      }

      function handleResize(msg: Record<string, unknown>) {
        const session = sessions.get(msg.id as string)
        if (session?.status === "running") {
          const cols = msg.cols as number
          const rows = msg.rows as number
          session.pty.resize(cols, rows)
          session.cols = cols
          session.rows = rows
        }
      }

      function handleKill(msg: Record<string, unknown>) {
        const session = sessions.get(msg.id as string)
        if (session) {
          if (session.status === "running") {
            session.pty.kill()
          }
          sessions.delete(msg.id as string)
          sendSessionList(wss, sessions)
        }
      }

      function handleAttach(ws: WebSocket, msg: Record<string, unknown>) {
        const session = sessions.get(msg.id as string)
        if (!session) {
          ws.send(
            JSON.stringify({
              type: "error",
              id: msg.id,
              message: "Session not found",
            })
          )
          return
        }
        session.clients.add(ws)
        if (session.scrollback.length > 0) {
          ws.send(
            JSON.stringify({
              type: "output",
              id: msg.id,
              data: session.scrollback,
            })
          )
        }
        if (session.status === "exited") {
          ws.send(
            JSON.stringify({
              type: "exit",
              id: msg.id,
              code: session.exitCode,
            })
          )
        }
      }

      function handleRename(msg: Record<string, unknown>) {
        const session = sessions.get(msg.id as string)
        if (session) {
          session.name = msg.name as string
          sendSessionList(wss, sessions)
        }
      }

      // Cleanup on server close
      server.httpServer!.on("close", () => {
        for (const session of sessions.values()) {
          if (session.status === "running") {
            session.pty.kill()
          }
        }
        sessions.clear()
      })
    },
  }
}
