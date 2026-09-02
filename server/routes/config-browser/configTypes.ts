import {
  AGENT_KINDS,
  allDescriptors,
  descriptorForDirName,
} from "../../../shared/session/agent-descriptors"
import type { ConfigCli } from "../../../shared/contracts/configBrowser"

export type {
  ConfigCli,
  ConfigTreeItem,
  ConfigTreeSection,
} from "../../../shared/contracts/configBrowser"

/**
 * The tree several CLIs symlink their own directories into. No agent reads it
 * directly, which is why an entry found only here is flagged as unlinked.
 */
export const SHARED_CONFIG_DIR_NAME = ".agents"

/**
 * Column order for the "loaded by" badges, and — because `unionCli` filters
 * through it — the set of CLIs a merge is allowed to keep. Any agent missing
 * from this list is silently dropped when two directories collapse into one
 * entry, so it is derived from the registry rather than hand-listed.
 *
 * Detection order puts the agent that owns every unprefixed project last; the
 * config browser reads better with it first, since it owns the most rows.
 */
const DEFAULT_CLI: ConfigCli = descriptorForDirName(null).kind
export const CLI_ORDER: readonly ConfigCli[] = [
  DEFAULT_CLI,
  ...AGENT_KINDS.filter((kind) => kind !== DEFAULT_CLI),
]

/** Directory names that mark a trusted configuration root. */
export const CONFIG_ROOT_DIR_NAMES: ReadonlySet<string> = new Set([
  SHARED_CONFIG_DIR_NAME,
  ...allDescriptors().map((descriptor) => descriptor.config.rootDirName),
])

export interface CliSourceDir {
  dir: string
  /** CLIs loading this directory. Empty means a shared source no CLI reads directly. */
  cli: ConfigCli[]
}

export interface CliSourceFile {
  path: string
  name: string
  cli: ConfigCli[]
}

export interface ConfigScopeLayout {
  /** Directory new files are created in, and the anchor for the section. */
  baseDir: string
  instructions: CliSourceFile[]
  settings: CliSourceFile[]
  skills: CliSourceDir[]
  agents: CliSourceDir[]
  commands: CliSourceDir[]
  /** Global-only theme directories, one per CLI that has them. */
  themes: CliSourceDir[]
  /** Global-only installed-plugin trees, one per CLI that has them. */
  plugins: CliSourceDir[]
}
