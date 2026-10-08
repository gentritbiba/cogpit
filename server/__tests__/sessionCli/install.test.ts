// @vitest-environment node
import { execFile } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { binDir } from "../../browser/paths"
import {
  ensureSessionCli,
  renderCmdLauncher,
  renderPosixLauncher,
  sessionCliPath,
} from "../../sessionCli/install"

let root = ""
let server: Server | null = null

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cogpit-session-cli-"))
  vi.stubEnv("COGPIT_BROWSER_HOME", join(root, "browser"))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
  rmSync(root, { recursive: true, force: true })
})

/** A stand-in Cogpit that records the forwarded body and answers with `reply`. */
async function fakeCogpit(status: number, reply: unknown): Promise<{ port: number; bodies: unknown[] }> {
  const bodies: unknown[] = []
  server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => { body += chunk })
    req.on("end", () => {
      bodies.push({ url: req.url, ...JSON.parse(body) })
      res.statusCode = status
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify(reply))
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
  return { port: (server!.address() as AddressInfo).port, bodies }
}

function runScript(args: string[], env: Record<string, string>, stdin?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(process.execPath, [join(binDir(), "cogpit-session.mjs"), ...args], {
      cwd: root,
      env: { ...process.env, ...env },
    }, (error, stdout, stderr) => resolve({ code: error ? (error.code as number) : 0, stdout, stderr }))
    child.stdin?.end(stdin ?? "")
  })
}

describe("ensureSessionCli", () => {
  it("writes the script and an executable launcher bound to the given runtime", () => {
    ensureSessionCli("/opt/cogpit/runtime", "darwin")
    const launcher = readFileSync(sessionCliPath("darwin"), "utf8")
    expect(launcher).toBe(renderPosixLauncher("/opt/cogpit/runtime"))
    if (process.platform !== "win32") expect(statSync(sessionCliPath("darwin")).mode & 0o111).not.toBe(0)
    expect(readFileSync(join(binDir(), "cogpit-session.mjs"), "utf8")).toContain("/api/session-cli")
  })

  it("adds a .cmd launcher on Windows", () => {
    ensureSessionCli("C:\\Cogpit\\Cogpit.exe", "win32")
    expect(readFileSync(sessionCliPath("win32"), "utf8")).toBe(renderCmdLauncher("C:\\Cogpit\\Cogpit.exe"))
  })

  it("quotes a runtime path containing a single quote", () => {
    expect(renderPosixLauncher("/Apps/Bob's/cogpit")).toContain(`runtime='/Apps/Bob'\\''s/cogpit'`)
  })
})

describe("the installed script", () => {
  it("forwards argv, cwd, caller and stdin, then prints the server's output and exit code", async () => {
    ensureSessionCli()
    const { port, bodies } = await fakeCogpit(200, { exitCode: 2, stdout: "{\"ok\":true}\n", stderr: "careful\n" })

    const result = await runScript(["send", "s1", "-"], {
      COGPIT_PORT: String(port),
      COGPIT_SESSION_ID: "parent-1",
    }, "message from stdin")

    expect(result).toEqual({ code: 2, stdout: "{\"ok\":true}\n", stderr: "careful\n" })
    expect(bodies).toEqual([{
      url: "/api/session-cli",
      argv: ["send", "s1", "message from stdin"],
      cwd: expect.stringContaining("cogpit-session-cli-"),
      invocationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      callerSessionId: "parent-1",
    }])
  })

  it("explains an older Cogpit that has no session CLI endpoint", async () => {
    ensureSessionCli()
    const { port } = await fakeCogpit(404, { error: "Not found" })
    const result = await runScript(["status", "s1"], { COGPIT_PORT: String(port) })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("too old")
  })

  it.skipIf(process.platform === "win32")("runs through the POSIX launcher", async () => {
    ensureSessionCli(process.execPath)
    const { port } = await fakeCogpit(200, { exitCode: 0, stdout: "hello\n", stderr: "" })
    const result = await new Promise<{ stdout: string }>((resolve, reject) => {
      execFile(sessionCliPath(), ["help"], { env: { ...process.env, COGPIT_PORT: String(port) } }, (error, stdout) =>
        (error ? reject(error) : resolve({ stdout })))
    })
    expect(result.stdout).toBe("hello\n")
  })
})
