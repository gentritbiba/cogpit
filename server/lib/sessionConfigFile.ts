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

  constructor(
    private readonly fileName: string,
    private readonly state: StoreState,
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
    this.state.reset()
    this.loading = readFile(path, "utf-8")
      .then((raw) => this.state.apply(JSON.parse(raw)))
      .catch(() => {
        // Missing or corrupt file — start empty.
      })
      .finally(() => {
        this.loading = null
      })
    await this.loading
  }

  persist(): Promise<void> {
    const path = this.currentPath()
    const snapshot = this.state.snapshot()
    const write = this.writeChain.then(async () => {
      await mkdir(dirs.SESSION_CONFIG_DIR, { recursive: true })
      await writeOwnerOnlyJson(path, snapshot)
    })
    // A failed write must not poison later writes; each caller sees its own error.
    this.writeChain = write.catch(() => {})
    return write
  }

  resetForTest(): void {
    this.activePath = null
    this.loading = null
    this.writeChain = Promise.resolve()
    this.state.reset()
  }
}
