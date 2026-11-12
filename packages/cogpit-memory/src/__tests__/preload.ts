import { afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// No test may resolve the live memory store under the real home.
const memoryDir = mkdtempSync(join(tmpdir(), "cogpit-memory-store-"))
process.env.COGPIT_MEMORY_DIR = memoryDir
afterAll(() => rmSync(memoryDir, { recursive: true, force: true }))
