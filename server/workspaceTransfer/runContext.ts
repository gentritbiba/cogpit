import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join } from "node:path"
import type { WorkspaceRunContext } from "../../shared/contracts/workspaces"
import { serialQueue } from "../lib/serialQueue"

const allocations = serialQueue()

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

/** Keep allocations unique across projects until their workspace is discarded. */
export async function withRunContext<T>(root: string, workspaceId: string, save: (context: WorkspaceRunContext) => Promise<T>): Promise<T> {
  return allocations.run(async () => {
    const ports = new Set<number>()
    for (const repo of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!repo.isDirectory()) continue
      const directory = join(root, repo.name)
      for (const name of await readdir(directory).catch(() => [])) {
        if (!name.endsWith(".workspace.json")) continue
        const stored = await readFile(join(directory, name), "utf8").then((text) => JSON.parse(text) as { run?: WorkspaceRunContext }, () => null)
        if (stored?.run) ports.add(stored.run.port)
      }
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      const port = await availablePort()
      if (!port || ports.has(port)) continue
      const digest = createHash("sha256").update(workspaceId).digest("hex").slice(0, 16)
      return save({ port, composeProjectName: `cogpit-${digest}` })
    }
    throw new Error("Could not allocate a workspace dev-server port")
  })
}
