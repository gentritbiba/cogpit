// @vitest-environment node
import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"
import { expect, it } from "vitest"
import { OrchestrationStore } from "../../orchestration/store"

it("round-trips durable receipts and questions between Node and Bun", async () => {
  const root = await mkdtemp(join(tmpdir(), "cogpit-database-interop-"))
  const path = join(root, "state.sqlite")
  const binding = { hostId: "local", agent: "acp" as const, instanceId: "default", sessionId: "native-session" }
  try {
    const node = new OrchestrationStore(path)
    const conversation = node.ensureConversation(binding)
    node.admit("owner", "interop-command", conversation.id, { message: "Persisted request" })
    node.close()
    const source = pathToFileURL(resolve("server/orchestration/store.ts")).href
    const script = `import { OrchestrationStore } from ${JSON.stringify(source)};
      const store = new OrchestrationStore(${JSON.stringify(path)});
      const command = store.command("owner", "interop-command");
      if (command?.payload.message !== "Persisted request") throw new Error("Receipt lost across runtimes");
      store.putQuestion({ instanceId: "default", sessionId: "native-session", requestId: "question", data: { text: "Budget?" } });
      store.close();`
    await promisify(execFile)("bun", ["--eval", script], { timeout: 20_000 })
    const reopened = new OrchestrationStore(path)
    try {
      expect(reopened.command("owner", "interop-command")?.receipt).toMatchObject({ conversationId: conversation.id, state: "queued" })
      expect(reopened.questions("default", binding.sessionId)).toEqual([expect.objectContaining({ requestId: "question", data: { text: "Budget?" } })])
    } finally { reopened.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30_000)
