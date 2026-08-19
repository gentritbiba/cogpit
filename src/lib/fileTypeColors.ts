import {
  File,
  FileCode2,
  FileImage,
  FileJson,
  FileTerminal,
  FileText,
  type LucideIcon,
} from "lucide-react"

/**
 * Shared file-type styling for file browsers and diff headers.
 *
 * Every colour pairs a light-mode shade with a dark-mode shade because the app
 * ships light, dark, and OLED themes — a single Tailwind shade that reads well
 * on the dark surface washes out on the light one.
 */
const COLORS = {
  blue: "text-blue-600 dark:text-blue-400",
  sky: "text-sky-700 dark:text-blue-300",
  yellow: "text-yellow-700 dark:text-yellow-400",
  amber: "text-amber-700 dark:text-amber-400",
  orange: "text-orange-700 dark:text-orange-400",
  red: "text-red-600 dark:text-red-400",
  green: "text-green-700 dark:text-green-400",
  emerald: "text-emerald-700 dark:text-emerald-400",
  cyan: "text-cyan-700 dark:text-cyan-400",
  indigo: "text-indigo-600 dark:text-indigo-400",
  purple: "text-purple-600 dark:text-purple-400",
  pink: "text-pink-600 dark:text-pink-400",
} as const

const DEFAULT_COLOR = "text-muted-foreground"

const EXTENSION_COLORS: Record<string, string> = {
  tsx: COLORS.blue,
  jsx: COLORS.blue,
  ts: COLORS.yellow,
  js: COLORS.yellow,
  mjs: COLORS.yellow,
  cjs: COLORS.yellow,
  css: COLORS.purple,
  scss: COLORS.purple,
  sass: COLORS.purple,
  less: COLORS.purple,
  json: COLORS.amber,
  jsonc: COLORS.amber,
  yaml: COLORS.amber,
  yml: COLORS.amber,
  toml: COLORS.amber,
  md: COLORS.sky,
  mdx: COLORS.sky,
  txt: COLORS.sky,
  py: COLORS.green,
  rs: COLORS.orange,
  go: COLORS.cyan,
  html: COLORS.orange,
  htm: COLORS.orange,
  vue: COLORS.emerald,
  svelte: COLORS.orange,
  sh: COLORS.emerald,
  bash: COLORS.emerald,
  zsh: COLORS.emerald,
  fish: COLORS.emerald,
  sql: COLORS.cyan,
  rb: COLORS.red,
  java: COLORS.red,
  kt: COLORS.indigo,
  swift: COLORS.orange,
  php: COLORS.indigo,
  c: COLORS.blue,
  h: COLORS.blue,
  cpp: COLORS.blue,
  cc: COLORS.blue,
  hpp: COLORS.blue,
  cs: COLORS.purple,
  png: COLORS.pink,
  jpg: COLORS.pink,
  jpeg: COLORS.pink,
  gif: COLORS.pink,
  webp: COLORS.pink,
  svg: COLORS.pink,
  ico: COLORS.pink,
}

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

export function fileTypeColor(path: string): string {
  return EXTENSION_COLORS[fileExtension(path)] ?? DEFAULT_COLOR
}

export function fileTypeIcon(path: string): LucideIcon {
  const extension = fileExtension(path)
  return EXTENSION_ICONS[extension] ?? (extension in EXTENSION_COLORS ? FileCode2 : File)
}
