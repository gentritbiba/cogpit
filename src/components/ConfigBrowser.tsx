import { useState, useEffect, useCallback, useRef, memo } from "react"
import {
  FileText,
  Globe,
  FolderCode,
  Plug,
  Lock,
  Plus,
  Trash2,
  Save,
  Undo2,
  Bot,
  Terminal,
  Sparkles,
  FileJson,
  BookOpen,
  X,
} from "lucide-react"
import type { ThemedToken } from "shiki"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { authFetch } from "@/lib/auth"
import { highlightCode, getLangFromPath } from "@/lib/shiki"
import { useIsDarkMode } from "@/hooks/useIsDarkMode"

// ── Types ──────────────────────────────────────────────────────────────

interface ConfigTreeItem {
  name: string
  path: string
  type: "file" | "directory"
  fileType?: "command" | "skill" | "agent" | "claude-md" | "settings" | "unknown"
  description?: string
  children?: ConfigTreeItem[]
  readOnly?: boolean
}

interface ConfigTreeSection {
  label: string
  scope: "global" | "project" | "plugin"
  pluginName?: string
  baseDir?: string
  items: ConfigTreeItem[]
}

/** A flattened config item for the category view and editor selection */
interface ConfigItem {
  name: string
  path: string
  fileType: string
  description: string
  scope: "global" | "project" | "plugin" | string
  pluginName?: string
  readOnly: boolean
}

type Category = "instructions" | "agents" | "skills" | "commands" | "settings"

const BADGE_COLORS: Record<string, string> = {
  agent: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  skill: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  command: "bg-green-500/20 text-green-300 border-green-500/30",
  "claude-md": "bg-blue-500/20 text-blue-300 border-blue-500/30",
  settings: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
}

const CATEGORY_DIR_MAP: Record<string, { subdir: string; fileType: "command" | "skill" | "agent" }> = {
  agents: { subdir: "agents", fileType: "agent" },
  skills: { subdir: "skills", fileType: "skill" },
  commands: { subdir: "commands", fileType: "command" },
}

const CATEGORY_ORDER: Category[] = ["instructions", "agents", "skills", "commands", "settings"]

const CATEGORY_META: Record<Category, { label: string; icon: typeof BookOpen; color: string }> = {
  instructions: { label: "Instructions", icon: BookOpen, color: "text-blue-400" },
  agents: { label: "Agents", icon: Bot, color: "text-purple-400" },
  skills: { label: "Skills", icon: Sparkles, color: "text-amber-400" },
  commands: { label: "Commands", icon: Terminal, color: "text-green-400" },
  settings: { label: "Settings", icon: FileJson, color: "text-cyan-400" },
}

// ── Flatten tree into categories ───────────────────────────────────────

function flattenItems(
  items: ConfigTreeItem[],
  scope: ConfigTreeSection["scope"],
  pluginName?: string,
): ConfigItem[] {
  const result: ConfigItem[] = []
  for (const item of items) {
    if (item.type === "directory" && item.children) {
      result.push(...flattenItems(item.children, scope, pluginName))
    } else if (item.type === "file") {
      result.push({
        name: item.name,
        path: item.path,
        fileType: item.fileType || "unknown",
        description: item.description || "",
        scope,
        pluginName,
        readOnly: item.readOnly ?? (scope === "plugin"),
      })
    }
  }
  return result
}

function categorizeItems(sections: ConfigTreeSection[]): Record<Category, ConfigItem[]> {
  const categories: Record<Category, ConfigItem[]> = {
    instructions: [],
    agents: [],
    skills: [],
    commands: [],
    settings: [],
  }

  for (const section of sections) {
    const items = flattenItems(section.items, section.scope, section.pluginName)
    for (const item of items) {
      switch (item.fileType) {
        case "claude-md":
          categories.instructions.push(item)
          break
        case "agent":
          categories.agents.push(item)
          break
        case "skill":
          categories.skills.push(item)
          break
        case "command":
          categories.commands.push(item)
          break
        case "settings":
          categories.settings.push(item)
          break
        default:
          categories.settings.push(item)
      }
    }
  }

  return categories
}

// ── Scope badge ────────────────────────────────────────────────────────

function ScopeBadge({ scope, pluginName }: { scope: string; pluginName?: string }) {
  if (scope === "plugin" && pluginName) {
    return (
      <span className="flex items-center gap-0.5 text-[9px] text-purple-400/70 shrink-0">
        <Plug className="size-2.5" />
        {pluginName}
      </span>
    )
  }
  if (scope === "project") {
    return (
      <span className="flex items-center gap-0.5 text-[9px] text-green-400/70 shrink-0">
        <FolderCode className="size-2.5" />
        project
      </span>
    )
  }
  return (
    <span className="flex items-center gap-0.5 text-[9px] text-blue-400/50 shrink-0">
      <Globe className="size-2.5" />
      global
    </span>
  )
}

// ── New file dialog ────────────────────────────────────────────────────

function NewFileDialog({
  globalDir,
  projectDir,
  fileType,
  onCreated,
  onCancel,
}: {
  globalDir: string | null
  projectDir: string | null
  fileType: "command" | "skill" | "agent"
  onCreated: (path: string, fileType: string, scope: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState("")
  const [scope, setScope] = useState<"global" | "project">(projectDir ? "project" : "global")
  const [creating, setCreating] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const targetDir = scope === "project" && projectDir ? projectDir : globalDir
  const hasBothScopes = !!globalDir && !!projectDir

  const handleCreate = async () => {
    if (!name.trim() || !targetDir) return
    setCreating(true)
    try {
      const res = await authFetch("/api/config-browser/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir: targetDir, fileType, name: name.trim() }),
      })
      if (res.ok) {
        const data = await res.json()
        onCreated(data.path, fileType, scope)
      }
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="px-3 py-1.5 space-y-1.5">
      {hasBothScopes && (
        <div className="flex items-center gap-1 rounded-md bg-elevation-0 p-0.5">
          <button
            className={cn(
              "flex-1 flex items-center justify-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium transition-colors",
              scope === "global" ? "bg-blue-500/20 text-blue-400" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setScope("global")}
          >
            <Globe className="size-2.5" />
            Global
          </button>
          <button
            className={cn(
              "flex-1 flex items-center justify-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium transition-colors",
              scope === "project" ? "bg-green-500/20 text-green-400" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setScope("project")}
          >
            <FolderCode className="size-2.5" />
            Project
          </button>
        </div>
      )}
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleCreate()
            if (e.key === "Escape") onCancel()
          }}
          placeholder={`${fileType} name...`}
          className="flex-1 bg-elevation-0 border border-border rounded px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-blue-500/50 min-w-0"
          disabled={creating}
        />
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={handleCreate} disabled={creating || !name.trim()}>
          <Save className="size-3 text-green-400" />
        </Button>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onCancel}>
          <X className="size-3" />
        </Button>
      </div>
    </div>
  )
}

// ── Category section ───────────────────────────────────────────────────

function CategorySection({
  category,
  items,
  selectedPath,
  onSelect,
  onNewFile,
  creatingInCategory,
  onCreated,
  onCancelCreate,
}: {
  category: Category
  items: ConfigItem[]
  selectedPath: string | null
  onSelect: (item: ConfigItem) => void
  onNewFile?: () => void
  creatingInCategory: { globalDir: string | null; projectDir: string | null; fileType: "command" | "skill" | "agent" } | null
  onCreated: (path: string, fileType: string, scope: string) => void
  onCancelCreate: () => void
}) {
  const meta = CATEGORY_META[category]
  const Icon = meta.icon

  if (items.length === 0 && !onNewFile) return null

  return (
    <div className="mb-0.5">
      {/* Category header */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 group">
        <Icon className={cn("size-3", meta.color)} />
        <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider flex-1">{meta.label}</span>
        <span className="text-[10px] text-muted-foreground/40">{items.length}</span>
        {onNewFile && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                onClick={onNewFile}
              >
                <Plus className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent>New {category.slice(0, -1)}</TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Items */}
      {items.map((item) => {
        const isSelected = selectedPath === item.path
        return (
          <button
            key={item.path}
            className={cn(
              "flex items-center gap-2 w-full text-left px-3 py-1.5 transition-colors",
              isSelected
                ? "bg-blue-500/10 text-foreground border-l-2 border-blue-400"
                : "hover:bg-elevation-2 text-foreground/80 hover:text-foreground border-l-2 border-transparent",
            )}
            onClick={() => onSelect(item)}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs truncate">{item.name}</span>
                {item.readOnly && <Lock className="size-2.5 text-muted-foreground/40 shrink-0" />}
              </div>
              {item.description && (
                <p className="text-[10px] text-muted-foreground/50 truncate mt-0.5">{item.description}</p>
              )}
            </div>
            <ScopeBadge scope={item.scope} pluginName={item.pluginName} />
          </button>
        )
      })}

      {items.length === 0 && !creatingInCategory && (
        <p className="text-[10px] text-muted-foreground/30 px-3 py-1">None configured</p>
      )}

      {/* Inline creation */}
      {creatingInCategory && (
        <NewFileDialog
          globalDir={creatingInCategory.globalDir}
          projectDir={creatingInCategory.projectDir}
          fileType={creatingInCategory.fileType}
          onCreated={onCreated}
          onCancel={onCancelCreate}
        />
      )}
    </div>
  )
}

// ── Syntax-highlighted editor ──────────────────────────────────────────

function HighlightedEditor({
  value,
  onChange,
  readOnly,
  filePath,
}: {
  value: string
  onChange: (v: string) => void
  readOnly: boolean
  filePath: string
}) {
  const isDark = useIsDarkMode()
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const preRef = useRef<HTMLPreElement>(null)

  // Determine language from file path
  const lang = getLangFromPath(filePath) ?? "markdown"

  // Highlight with debounce
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      highlightCode(value, lang, isDark).then((result) => {
        if (!cancelled) setTokens(result)
      })
    }, 80)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [value, lang, isDark])

  // Sync scroll between textarea and highlighted pre
  const handleScroll = useCallback(() => {
    if (textareaRef.current && preRef.current) {
      preRef.current.scrollTop = textareaRef.current.scrollTop
      preRef.current.scrollLeft = textareaRef.current.scrollLeft
    }
  }, [])

  return (
    <div className="relative flex-1 min-h-0 bg-elevation-0">
      {/* Highlighted layer (behind) */}
      <pre
        ref={preRef}
        aria-hidden
        className={cn(
          "absolute inset-0 overflow-hidden font-mono text-[13px] leading-relaxed p-4 m-0 pointer-events-none whitespace-pre-wrap break-words",
          readOnly && "opacity-70",
        )}
      >
        {tokens ? (
          tokens.map((line, i) => (
            <span key={i}>
              {line.map((token, j) => (
                <span key={j} style={{ color: token.color }}>{token.content}</span>
              ))}
              {"\n"}
            </span>
          ))
        ) : (
          <code className="text-foreground">{value}</code>
        )}
      </pre>

      {/* Editable textarea (on top, transparent text) */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={handleScroll}
        readOnly={readOnly}
        spellCheck={false}
        className={cn(
          "absolute inset-0 w-full h-full resize-none bg-transparent font-mono text-[13px] leading-relaxed p-4 outline-none",
          "text-transparent caret-foreground selection:bg-blue-500/30",
          "scrollbar-thin scrollbar-track-transparent scrollbar-thumb-border",
          readOnly && "cursor-default",
        )}
        placeholder="Empty file"
      />
    </div>
  )
}

// ── Editor area ────────────────────────────────────────────────────────

function ConfigEditor({
  file,
  onDeleted,
}: {
  file: ConfigItem
  onDeleted: () => void
}) {
  const [content, setContent] = useState<string | null>(null)
  const [originalContent, setOriginalContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const hasChanges = content !== null && content !== originalContent

  // Load file content
  useEffect(() => {
    setLoading(true)
    setContent(null)
    setOriginalContent(null)
    setSaved(false)
    setConfirmDelete(false)

    authFetch(`/api/config-browser/file?path=${encodeURIComponent(file.path)}`)
      .then((res) => res.json())
      .then((data) => {
        setContent(data.content ?? "")
        setOriginalContent(data.content ?? "")
      })
      .catch(() => {
        setContent("")
        setOriginalContent("")
      })
      .finally(() => setLoading(false))
  }, [file.path])

  const handleSave = useCallback(async () => {
    if (!hasChanges || file.readOnly) return
    setSaving(true)
    try {
      const res = await authFetch("/api/config-browser/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: file.path, content }),
      })
      if (res.ok) {
        setOriginalContent(content)
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      }
    } finally {
      setSaving(false)
    }
  }, [content, file.path, file.readOnly, hasChanges])

  const handleDiscard = useCallback(() => {
    setContent(originalContent)
    setConfirmDelete(false)
  }, [originalContent])

  const handleDelete = useCallback(async () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    try {
      const res = await authFetch(`/api/config-browser/file?path=${encodeURIComponent(file.path)}`, {
        method: "DELETE",
      })
      if (res.ok) onDeleted()
    } catch { /* ignore */ }
  }, [confirmDelete, file.path, onDeleted])

  // Ctrl+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [handleSave])

  return (
    <div className="flex flex-1 flex-col min-h-0 min-w-0">
      {/* Metadata bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border/50 bg-elevation-1 shrink-0">
        <Badge variant="outline" className={cn("text-[10px] h-5", BADGE_COLORS[file.fileType] || "bg-zinc-500/20 text-zinc-300 border-zinc-500/30")}>
          {file.fileType}
        </Badge>
        <ScopeBadge scope={file.scope} pluginName={file.pluginName} />
        {file.readOnly && (
          <Badge variant="outline" className="text-[10px] h-5 bg-zinc-500/20 text-zinc-400 border-zinc-500/30">
            <Lock className="size-2.5 mr-0.5" /> read-only
          </Badge>
        )}
        {hasChanges && (
          <span className="size-2 rounded-full bg-amber-400 shrink-0" title="Unsaved changes" />
        )}
        <span className="text-[11px] font-mono text-muted-foreground/50 truncate ml-auto" title={file.path}>
          {file.path}
        </span>
      </div>

      {/* Editor */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          Loading...
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <HighlightedEditor
            value={content ?? ""}
            onChange={setContent}
            readOnly={file.readOnly}
            filePath={file.path}
          />

          {/* Action bar */}
          <div className="flex items-center gap-2 px-4 py-2 border-t border-border/50 bg-elevation-1 shrink-0">
            {!file.readOnly && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "h-7 px-3 text-xs gap-1.5",
                    hasChanges ? "text-green-400 hover:text-green-300 hover:bg-green-500/10" : "text-muted-foreground",
                  )}
                  onClick={handleSave}
                  disabled={!hasChanges || saving}
                >
                  <Save className="size-3" />
                  {saved ? "Saved!" : saving ? "Saving..." : "Save"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-3 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
                  onClick={handleDiscard}
                  disabled={!hasChanges}
                >
                  <Undo2 className="size-3" />
                  Discard
                </Button>
                <div className="flex-1" />
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "h-7 px-3 text-xs gap-1.5",
                    confirmDelete ? "text-red-400 bg-red-500/10 hover:bg-red-500/20" : "text-muted-foreground hover:text-red-400 hover:bg-red-500/10",
                  )}
                  onClick={handleDelete}
                >
                  <Trash2 className="size-3" />
                  {confirmDelete ? "Confirm delete?" : "Delete"}
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Empty state ────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
      <div className="flex items-center gap-2 text-muted-foreground/30">
        <FileText className="size-8" />
      </div>
      <p className="text-sm">Select a config to view or edit</p>
      <p className="text-xs text-muted-foreground/40 max-w-[260px] text-center">
        Browse your Claude configuration — instructions, agents, skills, commands, and settings
      </p>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────

interface ConfigBrowserProps {
  projectPath: string | null
  initialFilePath?: string | null
}

export const ConfigBrowser = memo(function ConfigBrowser({ projectPath, initialFilePath }: ConfigBrowserProps) {
  const [sections, setSections] = useState<ConfigTreeSection[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedFile, setSelectedFile] = useState<ConfigItem | null>(null)
  const [creating, setCreating] = useState<{ category: Category; globalDir: string | null; projectDir: string | null; fileType: "command" | "skill" | "agent" } | null>(null)
  const initialFileLoadedRef = useRef(false)

  // Fetch tree
  const fetchTree = useCallback(async () => {
    setLoading(true)
    try {
      const url = projectPath
        ? `/api/config-browser/tree?cwd=${encodeURIComponent(projectPath)}`
        : "/api/config-browser/tree"
      const res = await authFetch(url)
      if (res.ok) {
        const data = await res.json()
        setSections(data.sections || [])
      }
    } finally {
      setLoading(false)
    }
  }, [projectPath])

  useEffect(() => { fetchTree() }, [fetchTree])

  // Auto-select initial file when tree loads
  useEffect(() => {
    if (!initialFilePath || loading || initialFileLoadedRef.current) return
    const match = sections.flatMap(s => flattenItems(s.items, s.scope, s.pluginName)).find(item => item.path === initialFilePath)
    if (match) {
      setSelectedFile(match)
      initialFileLoadedRef.current = true
    }
  }, [initialFilePath, loading, sections])

  // Derive categories from the flat tree
  const categories = categorizeItems(sections)

  // Find the global baseDir for creating new files
  const globalBaseDir = sections.find((s) => s.scope === "global")?.baseDir
  const projectBaseDir = sections.find((s) => s.scope === "project")?.baseDir

  const handleSelect = useCallback((item: ConfigItem) => {
    setSelectedFile(item)
    setCreating(null)
  }, [])

  const handleFileCreated = useCallback((path: string, fileType: string, scope: string) => {
    setCreating(null)
    fetchTree()
    setSelectedFile({ path, name: path.split("/").pop() || "", fileType, readOnly: false, scope, description: "" })
  }, [fetchTree])

  const handleDeleted = useCallback(() => {
    setSelectedFile(null)
    fetchTree()
  }, [fetchTree])

  const handleNewFile = useCallback((category: Category) => {
    if (!globalBaseDir && !projectBaseDir) return
    const mapping = CATEGORY_DIR_MAP[category]
    if (!mapping) return

    setCreating({
      category,
      globalDir: globalBaseDir ? `${globalBaseDir}/${mapping.subdir}` : null,
      projectDir: projectBaseDir ? `${projectBaseDir}/${mapping.subdir}` : null,
      fileType: mapping.fileType,
    })
  }, [globalBaseDir, projectBaseDir])

  return (
    <div className="flex flex-1 min-h-0 min-w-0">
      {/* Sidebar */}
      <div className="w-[260px] shrink-0 border-r border-border/50 bg-elevation-1 flex flex-col min-h-0">
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/50">
          <span className="text-xs font-medium text-foreground">Config Browser</span>
          {projectPath && (
            <span className="text-[10px] text-muted-foreground/40 truncate ml-auto" title={projectPath}>
              {projectPath.split("/").pop()}
            </span>
          )}
        </div>
        <ScrollArea className="flex-1">
          <div className="py-2">
            {loading ? (
              <p className="text-xs text-muted-foreground px-3 py-4 text-center">Loading...</p>
            ) : (
              CATEGORY_ORDER.map((cat) => {
                const canCreate = cat === "agents" || cat === "skills" || cat === "commands"
                return (
                  <CategorySection
                    key={cat}
                    category={cat}
                    items={categories[cat]}
                    selectedPath={selectedFile?.path ?? null}
                    onSelect={handleSelect}
                    onNewFile={canCreate ? () => handleNewFile(cat) : undefined}
                    creatingInCategory={creating?.category === cat ? creating : null}
                    onCreated={handleFileCreated}
                    onCancelCreate={() => setCreating(null)}
                  />
                )
              })
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Editor area */}
      {selectedFile ? (
        <ConfigEditor file={selectedFile} onDeleted={handleDeleted} />
      ) : (
        <EmptyState />
      )}
    </div>
  )
})
