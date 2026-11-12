// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { WebSocket, WebSocketServer } from "ws"

const mockSignInLaunch = vi.hoisted(() => vi.fn())
vi.mock("../agents/signIn", () => ({ agentSignInLaunch: mockSignInLaunch }))

import { startCore, type CoreLease } from "../core/supervisor"
import type { SocketAuthorizer } from "../pty-authorization"
import { PtySocketRelay } from "../pty-socket"

type Frame = Record<string, unknown>

const isWindows = process.platform === "win32"
let core: CoreLease | null = null
let server: Server
let wss: WebSocketServer
let origin: string
const relay = new PtySocketRelay()
/** Authorizers by the `?auth=` name a test connects with; none means a trusted local socket. */
const authorizers = new Map<string, SocketAuthorizer>()

beforeAll(async () => {
  core = await startCore({ dataDir: tmpdir() })
  server = createServer()
  wss = new WebSocketServer({ server })
  wss.on("connection", (ws, req) => {
    const name = new URL(req.url ?? "/", "http://localhost").searchParams.get("auth")
    relay.socketFor(req).handleConnection(ws, name ? authorizers.get(name) : undefined)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(() => {
  vi.useRealTimers()
  mockSignInLaunch.mockReset()
  authorizers.clear()
})

afterAll(async () => {
  relay.cleanup()
  for (const client of wss.clients) client.terminate()
  await new Promise<void>((resolve) => wss.close(() => resolve()))
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await core?.release()
})

class Panel {
  readonly ws: WebSocket
  private readonly frames: Frame[] = []
  private waiters: Array<() => void> = []
  readonly closed: Promise<number>

  constructor(auth?: string) {
    this.ws = new WebSocket(`${origin}/__pty${auth ? `?auth=${auth}` : ""}`)
    this.ws.on("message", (data) => {
      this.frames.push(JSON.parse(data.toString()) as Frame)
      for (const wake of this.waiters.splice(0)) wake()
    })
    this.closed = new Promise((resolve) => this.ws.once("close", (code) => resolve(code)))
  }

  async open(): Promise<this> {
    if (this.ws.readyState !== WebSocket.OPEN) await new Promise((resolve) => this.ws.once("open", resolve))
    return this
  }

  send(frame: Frame): void {
    this.ws.send(JSON.stringify(frame))
  }

  /** The first frame, received so far or later, that matches. */
  async until(matches: (frame: Frame) => boolean, timeoutMs = 15_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = this.frames.find(matches)
      if (found) return found
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`no matching frame; got ${JSON.stringify(this.frames)}`)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  /** A session's output so far, once it contains `needle`. */
  async output(id: string, needle: string): Promise<string> {
    let text = ""
    await this.until(() => {
      text = this.frames.filter((f) => f.type === "output" && f.id === id).map((f) => f.data).join("")
      return text.includes(needle)
    })
    return text
  }

  async sessions(): Promise<Array<{ id: string }>> {
    const before = this.frames.length
    this.send({ type: "list" })
    const frame = await this.until((f) => f.type === "sessions" && this.frames.indexOf(f) >= before)
    return frame.sessions as Array<{ id: string }>
  }

  close(): void {
    this.ws.close()
  }
}

/** Prints `text` and exits, without a shell's prompt in the way. */
function printing(text: string): Frame {
  return isWindows
    ? { command: "cmd.exe", args: `/d /s /c "echo ${text}"` }
    : { command: "/bin/sh", args: ["-c", `printf '%s\\n' ${text}`] }
}

describe("PtySocketRelay", () => {
  it("relays the terminal panel's protocol to the core's sessions", async () => {
    const panel = await new Panel().open()
    panel.send({ type: "spawn", id: "relay-basic", name: "Build", ...printing("relayed-output") })
    expect(await panel.until((f) => f.type === "spawned")).toEqual({ type: "spawned", id: "relay-basic", name: "Build" })
    await panel.output("relay-basic", "relayed-output")
    expect(await panel.until((f) => f.type === "exit" && f.id === "relay-basic")).toMatchObject({ code: 0 })

    const late = await new Panel().open()
    late.send({ type: "attach", id: "relay-basic" })
    await late.output("relay-basic", "relayed-output")
    panel.send({ type: "kill", id: "relay-basic" })
    panel.close()
    late.close()
  })

  describe("sign-in terminals", () => {
    it("runs the launch the server builds for the agent and account, never the client's command", async () => {
      // cmd.exe takes its `/c` line verbatim; elsewhere the arguments go one by one.
      mockSignInLaunch.mockReturnValue(isWindows
        ? { command: process.env.COMSPEC ?? "cmd.exe", args: ["/d", "/s", "/c", "\"echo signed^ in as %COGPIT_SIGN_IN_TEST%\""], verbatimArgs: true, env: { COGPIT_SIGN_IN_TEST: "work" } }
        : { command: "/bin/sh", args: ["-c", "printf 'signed in as %s\\n' \"$COGPIT_SIGN_IN_TEST\""], verbatimArgs: false, env: { COGPIT_SIGN_IN_TEST: "work" } })
      const panel = await new Panel().open()
      panel.send({ type: "spawn", id: "sign-in", ...printing("client-command"), signIn: { agent: "codex", instanceId: "work" } })

      await panel.output("sign-in", "signed in as work")
      expect(mockSignInLaunch).toHaveBeenCalledWith("codex", "work")
      panel.send({ type: "kill", id: "sign-in" })
      panel.close()
    })

    it("reports an agent with no sign-in instead of starting anything", async () => {
      mockSignInLaunch.mockReturnValue(null)
      const panel = await new Panel().open()
      panel.send({ type: "spawn", id: "no-sign-in", ...printing("client-command"), signIn: { agent: "acp" } })

      expect(await panel.until((f) => f.type === "error")).toEqual({
        type: "error",
        id: "no-sign-in",
        message: "Failed to spawn PTY: Error: This agent has no sign-in to run",
      })
      expect((await panel.sessions()).map((s) => s.id)).not.toContain("no-sign-in")
      panel.close()
    })

    it("starts the requested terminal when the sign-in names no known agent", async () => {
      const panel = await new Panel().open()
      panel.send({ type: "spawn", id: "unknown-agent", ...printing("requested-terminal"), signIn: { agent: "rm -rf" } })

      await panel.output("unknown-agent", "requested-terminal")
      expect(mockSignInLaunch).not.toHaveBeenCalled()
      panel.send({ type: "kill", id: "unknown-agent" })
      panel.close()
    })
  })

  describe("authorization", () => {
    it("checks every frame from the client and closes with 1008 before relaying one it refuses", async () => {
      const touches: boolean[] = []
      authorizers.set("refuse", (touch) => {
        touches.push(touch)
        return false
      })
      const panel = await new Panel("refuse").open()
      panel.send({ type: "spawn", id: "refused", ...printing("must-not-run") })

      expect(await panel.closed).toBe(1008)
      expect(touches).toContain(true)
      const observer = await new Panel().open()
      expect((await observer.sessions()).map((s) => s.id)).not.toContain("refused")
      observer.close()
    })

    it("closes with 1008 when a frame for the client arrives after its authorization ended", async () => {
      let allowed = true
      authorizers.set("expiring", (touch) => touch || allowed)
      const watcher = await new Panel("expiring").open()
      await watcher.sessions()

      allowed = false
      const other = await new Panel().open()
      other.send({ type: "spawn", id: "broadcast", ...printing("to-everyone") })
      expect(await watcher.closed).toBe(1008)
      other.send({ type: "kill", id: "broadcast" })
      other.close()
    })

    it("rechecks an idle connection every 5 seconds", async () => {
      let allowed = true
      authorizers.set("idle", () => allowed)
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
      const panel = await new Panel("idle").open()

      vi.advanceTimersByTime(5_000)
      expect(panel.ws.readyState).toBe(WebSocket.OPEN)
      allowed = false
      vi.advanceTimersByTime(5_000)
      expect(await panel.closed).toBe(1008)
    })
  })

  // Runs last: it stops the core this file shares.
  it.skipIf(isWindows)("ends every terminal when the core stops", async () => {
    const panel = await new Panel().open()
    panel.send({ type: "spawn", id: "outlive", command: "/bin/sh", args: ["-c", "echo PID:$$; exec sleep 60"] })
    const pid = Number(/PID:(\d+)/.exec(await panel.output("outlive", "PID:"))?.[1] ?? NaN)
    expect(pid).toBeGreaterThan(0)

    await core?.release()
    core = null
    const alive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 10_000, interval: 100 })
  })
})
