import type { ConfigCli } from "../../../shared/contracts/configBrowser"

export type {
  ConfigCli,
  ConfigTreeItem,
  ConfigTreeSection,
} from "../../../shared/contracts/configBrowser"

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
  themesDir?: string
}
