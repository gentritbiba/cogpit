export interface TerminalSession {
  id: string
  name: string
  status: "running" | "exited"
  exitCode: number | null
  createdAt: number
  cwd: string
}

// Client -> Server
export type ClientMessage =
  | { type: "spawn"; id: string; cols: number; rows: number; name?: string; cwd?: string; command?: string; args?: string[] }
  | { type: "input"; id: string; data: string }
  | { type: "resize"; id: string; cols: number; rows: number }
  | { type: "kill"; id: string }
  | { type: "attach"; id: string }
  | { type: "list" }
  | { type: "rename"; id: string; name: string }

// Server -> Client
export type ServerMessage =
  | { type: "output"; id: string; data: string }
  | { type: "exit"; id: string; code: number }
  | { type: "error"; id: string; message: string }
  | { type: "spawned"; id: string; name: string }
  | { type: "sessions"; sessions: TerminalSession[] }
  | { type: "session_update"; session: TerminalSession }
