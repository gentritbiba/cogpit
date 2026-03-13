import { WebSocket, WebSocketServer } from "ws"
import { spawn as ptySpawn, type IPty } from "node-pty"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"

interface PtySessionMetadata {
  type: "script" | "terminal"
  source?: string
  scriptName?: string
}

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
  metadata?: PtySessionMetadata
}

interface SessionInfo {
  id: string
  name: string
  status: "running" | "exited"
  exitCode: number | null
  createdAt: number
  cwd: string
  metadata?: PtySessionMetadata
}

function toSessionInfo(s: PtySession): SessionInfo {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    exitCode: s.exitCode,
    createdAt: s.createdAt,
    cwd: s.cwd,
    metadata: s.metadata,
  }
}

export class PtySessionManager {
  private sessions = new Map<string, PtySession>()
  private wss: WebSocketServer

  constructor(wss: WebSocketServer) {
    this.wss = wss
  }

  handleConnection(ws: WebSocket): void {
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>
        this.handleMessage(ws, msg)
      } catch {
        ws.send(JSON.stringify({ type: "error", id: "", message: "Invalid JSON" }))
      }
    })

    ws.on("close", () => {
      for (const session of this.sessions.values()) {
        session.clients.delete(ws)
      }
    })
  }

  private handleMessage(ws: WebSocket, msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "spawn":
        this.handleSpawn(ws, msg)
        break
      case "input":
        this.handleInput(msg)
        break
      case "resize":
        this.handleResize(msg)
        break
      case "kill":
        this.handleKill(msg)
        break
      case "attach":
        this.handleAttach(ws, msg)
        break
      case "list":
        this.handleList(ws)
        break
      case "rename":
        this.handleRename(msg)
        break
    }
  }

  private handleSpawn(ws: WebSocket, msg: Record<string, unknown>): void {
    const id = (msg.id as string) || randomUUID()
    const name = (msg.name as string) || `Terminal ${this.sessions.size + 1}`
    const cwd = (msg.cwd as string) || homedir()
    const cols = (msg.cols as number) || 80
    const rows = (msg.rows as number) || 24
    const command = (msg.command as string) || process.env.SHELL || "/bin/zsh"
    const args = (msg.args as string[]) || []
    const metadata = (msg.metadata as PtySessionMetadata | undefined)

    let pty: IPty
    try {
      pty = ptySpawn(command, args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
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
      metadata,
    }

    pty.onData((data: string) => {
      session.scrollback += data
      if (session.scrollback.length > 50_000) {
        const sliced = session.scrollback.slice(-40_000)
        const nlIndex = sliced.indexOf("\n")
        session.scrollback = nlIndex > 0 ? sliced.slice(nlIndex + 1) : sliced
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
      this.sendSessionList()
    })

    this.sessions.set(id, session)
    ws.send(JSON.stringify({ type: "spawned", id, name }))
    this.sendSessionList()
  }

  private handleInput(msg: Record<string, unknown>): void {
    const session = this.sessions.get(msg.id as string)
    if (session?.status === "running") {
      session.pty.write(msg.data as string)
    }
  }

  private handleResize(msg: Record<string, unknown>): void {
    const session = this.sessions.get(msg.id as string)
    if (session?.status === "running") {
      const cols = msg.cols as number
      const rows = msg.rows as number
      session.pty.resize(cols, rows)
      session.cols = cols
      session.rows = rows
    }
  }

  private handleKill(msg: Record<string, unknown>): void {
    const session = this.sessions.get(msg.id as string)
    if (session) {
      if (session.status === "running") {
        session.pty.kill()
      }
      this.sessions.delete(msg.id as string)
      this.sendSessionList()
    }
  }

  private handleAttach(ws: WebSocket, msg: Record<string, unknown>): void {
    const session = this.sessions.get(msg.id as string)
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

  private handleList(ws: WebSocket): void {
    ws.send(
      JSON.stringify({
        type: "sessions",
        sessions: Array.from(this.sessions.values()).map(toSessionInfo),
      })
    )
  }

  private handleRename(msg: Record<string, unknown>): void {
    const session = this.sessions.get(msg.id as string)
    if (session) {
      session.name = msg.name as string
      this.sendSessionList()
    }
  }

  private broadcastToAll(msg: object): void {
    const data = JSON.stringify(msg)
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data)
      }
    }
  }

  private sendSessionList(): void {
    this.broadcastToAll({
      type: "sessions",
      sessions: Array.from(this.sessions.values()).map(toSessionInfo),
    })
  }

  cleanup(): void {
    for (const session of this.sessions.values()) {
      if (session.status === "running") {
        session.pty.kill()
      }
    }
    this.sessions.clear()
  }

}
