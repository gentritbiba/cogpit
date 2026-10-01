import { rm } from "node:fs/promises"
import { dirs, join, mkdir, readFile } from "../helpers"
import { writeOwnerOnlyJson } from "../atomicJsonFile"

interface StoreState {
  /** Drop everything held in memory. */
  reset(): void
  /** Fill the empty state from the parsed file. */
  apply(parsed: unknown): void
  /** What to write back. */
  snapshot(): unknown
}

/** Undefined for a missing or corrupt file, which a store treats as empty. */
async function parseFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as unknown
  } catch {
    return undefined
  }
}

/**
 * A server-wide JSON record in the session-config directory, such as the
 * archive list or session lineage. Loaded once per directory — a data-root
 * switch or a test pointing elsewhere starts a fresh load — and written through
 * one chain so concurrent writers never interleave.
 */
export class SessionConfigFile {
  private activePath: string | null = null
  private loading: Promise<void> | null = null
  private writeChain: Promise<void> = Promise.resolve()
  /** A legacy file whose entries are in memory but not yet known to be on disk under the current name. */
  private legacyToRemove: string | null = null

  /**
   * `legacyFileName` is the name this record was stored under before a rename.
   * Its entries are folded in once, under the current file's, and it is then
   * removed.
   */
  constructor(
    private readonly fileName: string,
    private readonly state: StoreState,
    private readonly legacyFileName?: string,
  ) {}

  private currentPath(): string {
    return join(dirs.SESSION_CONFIG_DIR, this.fileName)
  }

  async load(): Promise<void> {
    const path = this.currentPath()
    if (this.activePath === path) {
      if (this.loading) await this.loading
      return
    }
    this.activePath = path
    this.legacyToRemove = null
    this.state.reset()
    this.loading = this.read(path).finally(() => {
      this.loading = null
    })
    await this.loading
  }

  private async read(path: string): Promise<void> {
    const legacyPath = this.legacyFileName && join(dirs.SESSION_CONFIG_DIR, this.legacyFileName)
    const legacy = legacyPath ? await parseFile(legacyPath) : undefined
    if (legacy !== undefined) this.state.apply(legacy)
    const current = await parseFile(path)
    if (current !== undefined) this.state.apply(current)
    if (legacyPath && legacy !== undefined) {
      // Removed by the first write that lands, this one or a later one; until
      // then the legacy file is the only durable copy of its entries.
      this.legacyToRemove = legacyPath
      await this.persist().catch(() => undefined)
    }
  }

  persist(): Promise<void> {
    const path = this.currentPath()
    const snapshot = this.state.snapshot()
    const write = this.writeChain.then(async () => {
      await mkdir(dirs.SESSION_CONFIG_DIR, { recursive: true })
      await writeOwnerOnlyJson(path, snapshot)
      const legacy = this.legacyToRemove
      if (legacy) {
        await rm(legacy, { force: true }).then(() => {
          if (this.legacyToRemove === legacy) this.legacyToRemove = null
        }, () => undefined)
      }
    })
    // A failed write must not poison later writes; each caller sees its own error.
    this.writeChain = write.catch(() => {})
    return write
  }

  resetForTest(): void {
    this.activePath = null
    this.loading = null
    this.writeChain = Promise.resolve()
    this.legacyToRemove = null
    this.state.reset()
  }
}
