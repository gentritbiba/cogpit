/** Isolated browser-QA host. Run after build:web; never starts a real provider. */
import { mkdir, mkdtemp, writeFile, readFile, appendFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"

const root = await mkdtemp(join(tmpdir(), "cogpit-worktree-qa-"))
const port = Number(process.env.WORKTREE_QA_PORT ?? 19730)
if (port < 19730 || port > 19739) throw new Error("Use WORKTREE QA ports 19730–19739")
process.env.COGPIT_SKILL_HOME = join(root, "skills")
process.env.COGPIT_BROWSER_HOME = join(root, "browser")
process.env.COGPIT_ORCHESTRATION_ROOT = join(root, "data")
process.env.CLAUDE_CONFIG_DIR = join(root, "provider")
process.env.CODEX_HOME = join(root, "other-provider")
process.env.COPILOT_HOME = join(root, "third-provider")
const { gitOutput } = await import("../../sessionStartup/project")
const { descriptorFor } = await import("../../../shared/session/agent-descriptors")
const { allRuntimes } = await import("../../agents/runtimes")
const { createServerComposition } = await import("../../app-server")
const project = join(root, "project")
const provider = join(root, "provider")
const data = join(root, "data")
await mkdir(project, { recursive: true }); await mkdir(data, { recursive: true })
await writeFile(join(project, "package.json"), JSON.stringify({ name: "setup-qa", scripts: { bootstrap: "printf configured-script-ready", setup: "touch repository-command-was-not-trusted" } }))
await gitOutput(project, ["init"])
await gitOutput(project, ["add", "package.json"])
await gitOutput(project, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "synthetic project"])
const descriptor = descriptorFor("claude")
const seedDir = join(provider, "projects", descriptor.dirName.encode(project))
await mkdir(seedDir, { recursive: true })
const seedId = randomUUID()
await writeFile(join(seedDir, `${seedId}.jsonl`), JSON.stringify({ type: "user", sessionId: seedId, cwd: project, timestamp: new Date().toISOString(), uuid: randomUUID(), message: { role: "user", content: "Synthetic worktree setup project" } }) + "\n")
await writeFile(join(data, "config.local.json"), JSON.stringify({ claudeDir: provider, defaultAgent: "claude" }))
let counter = 0
for (const runtime of allRuntimes()) {
  runtime.describeRuntime = async () => ({ installed: true })
  runtime.listModels = async () => [{ value: "fixture", label: "Synthetic provider", supportsEffort: false }]
  runtime.stop = async () => true
  runtime.start = async (request) => {
    const sessionId = randomUUID()
    request.onSessionId?.(sessionId)
    let cwd = request.cwd
    if (request.worktreeName) {
      const parent = request.worktreeName.includes("hook") ? join(root, "external-native-hook") : join(request.cwd, ".claude", "worktrees")
      await mkdir(parent, { recursive: true })
      cwd = join(parent, `${request.worktreeName}-${++counter}`)
      await gitOutput(request.cwd, ["worktree", "add", "-b", `fixture-${counter}`, cwd, "HEAD"], request.signal)
      await writeFile(join(cwd, "native-hook-marker"), "Native WorktreeCreate fixture ran once")
    }
    const dirName = descriptor.dirName.encode(cwd)
    const fileName = `${sessionId}.jsonl`
    const directory = join(provider, "projects", dirName)
    const filePath = join(directory, fileName)
    await mkdir(directory, { recursive: true })
    await writeFile(filePath, JSON.stringify({ type: "system", subtype: "init", sessionId, cwd, timestamp: new Date().toISOString() }) + "\n")
    await request.beforeFirstTurn?.({ sessionId, cwd, nativeWorktree: !!request.worktreeName })
    request.signal?.throwIfAborted()
    await appendFile(join(root, "first-prompts.jsonl"), JSON.stringify({ sessionId, cwd, message: request.message }) + "\n")
    await appendFile(filePath, JSON.stringify({ type: "user", sessionId, cwd, uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: "user", content: request.message } }) + "\n" + JSON.stringify({ type: "assistant", sessionId, cwd, uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: "assistant", model: "fixture", usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: "text", text: "Synthetic first prompt delivered after worktree readiness." }] } }) + "\n")
    return { sessionId, cwd, dirName, fileName, filePath, initialContent: await readFile(filePath, "utf8") }
  }
}
const composition = await createServerComposition(resolve("dist"), data, { mode: "standalone" })
await new Promise<void>((resolve) => composition.httpServer.listen(port, "127.0.0.1", resolve))
console.log(JSON.stringify({ root, project, dirName: descriptor.dirName.encode(project), port, url: `http://127.0.0.1:${port}` }))
let closed = false
async function close() { if (closed) return; closed = true; await composition.dispose(); process.exit(0) }
process.on("SIGTERM", () => void close())
process.on("SIGINT", () => void close())
