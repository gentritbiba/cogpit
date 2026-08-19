import {
  File,
  FileCode2,
  FileImage,
  FileJson,
  FileTerminal,
  FileText,
  type LucideIcon,
} from "lucide-react"

const CODE_EXTENSIONS = new Set([
  "tsx", "jsx", "ts", "js", "mjs", "cjs", "css", "scss", "sass", "less",
  "yaml", "yml", "toml", "py", "rs", "go", "html", "htm", "vue", "svelte", "sql",
  "rb", "java", "kt", "swift", "php", "c", "h", "cpp", "cc", "hpp", "cs",
])

const EXTENSION_ICONS: Record<string, LucideIcon> = {
  json: FileJson,
  jsonc: FileJson,
  md: FileText,
  mdx: FileText,
  txt: FileText,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  svg: FileImage,
  ico: FileImage,
  sh: FileTerminal,
  bash: FileTerminal,
  zsh: FileTerminal,
  fish: FileTerminal,
}

/**
 * Lower-cased extension of a path, or "" when there is none. Dotfiles report
 * their bare name (`.gitignore` → `gitignore`) so they still get a label.
 */
export function fileExtension(path: string): string {
  const basename = path.split("/").at(-1) ?? path
  const dot = basename.lastIndexOf(".")
  return dot === -1 ? "" : basename.slice(dot + 1).toLowerCase()
}

export function fileTypeIcon(path: string): LucideIcon {
  const extension = fileExtension(path)
  return EXTENSION_ICONS[extension] ?? (CODE_EXTENSIONS.has(extension) ? FileCode2 : File)
}
