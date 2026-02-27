import { useState, useEffect, useCallback, useRef, memo } from "react"
import { Search, X } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { authFetch } from "@/lib/auth"
import type { ConfigTreeSection, Category, ConfigItem } from "@/components/config/config-types"
import { CATEGORY_ORDER, CATEGORY_DIR_MAP, flattenItems, categorizeItems } from "@/components/config/config-types"
import { CategorySection } from "@/components/config/CategorySection"
import { ConfigEditor } from "@/components/config/ConfigEditor"
import { EmptyState } from "@/components/config/EmptyState"

// ── Helpers ─────────────────────────────────────────────────────────────

function filterItemsByQuery(items: ConfigItem[], query: string): ConfigItem[] {
  if (!query) return items
  const q = query.toLowerCase()
  return items.filter(
    (item) =>
      item.name.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.path.toLowerCase().includes(q),
  )
}

// ── Main component ──────────────────────────────────────────────────────

interface ConfigBrowserProps {
  projectPath: string | null
  initialFilePath?: string | null
}

export const ConfigBrowser = memo(function ConfigBrowser({ projectPath, initialFilePath }: ConfigBrowserProps) {
  const [sections, setSections] = useState<ConfigTreeSection[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedFile, setSelectedFile] = useState<ConfigItem | null>(null)
  const [creating, setCreating] = useState<{ category: Category; globalDir: string | null; projectDir: string | null; fileType: "command" | "skill" | "agent" } | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [renamingItem, setRenamingItem] = useState<ConfigItem | null>(null)
  const [renameValue, setRenameValue] = useState("")
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
    const match = sections
      .flatMap((s) => flattenItems(s.items, s.scope, s.pluginName))
      .find((item) => item.path === initialFilePath)
    if (match) {
      setSelectedFile(match)
      initialFileLoadedRef.current = true
    }
  }, [initialFilePath, loading, sections])

  // Derive and filter categories
  const categories = categorizeItems(sections)
  const filteredCategories = Object.fromEntries(
    CATEGORY_ORDER.map((cat) => [cat, filterItemsByQuery(categories[cat], searchQuery)]),
  ) as Record<Category, ConfigItem[]>

  // Base directories for creating new files
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

  const handleDeleteItem = useCallback(async (item: ConfigItem) => {
    if (item.readOnly) return
    if (!window.confirm(`Delete "${item.name}"? This cannot be undone.`)) return
    try {
      const res = await authFetch(`/api/config-browser/file?path=${encodeURIComponent(item.path)}`, { method: "DELETE" })
      if (res.ok) {
        if (selectedFile?.path === item.path) setSelectedFile(null)
        fetchTree()
      }
    } catch { /* ignore */ }
  }, [fetchTree, selectedFile])

  const handleStartRename = useCallback((item: ConfigItem) => {
    if (item.readOnly) return
    const name = item.name === "SKILL.md"
      ? item.path.split("/").slice(-2, -1)[0] || item.name
      : item.name.replace(/\.[^.]+$/, "")
    setRenamingItem(item)
    setRenameValue(name)
  }, [])

  const handleRenameSubmit = useCallback(async () => {
    if (!renamingItem || !renameValue.trim()) return
    try {
      const res = await authFetch("/api/config-browser/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPath: renamingItem.path, newName: renameValue.trim() }),
      })
      if (res.ok) {
        const data = await res.json()
        setRenamingItem(null)
        setRenameValue("")
        await fetchTree()
        if (data.newPath) {
          setSelectedFile({
            ...renamingItem,
            path: data.newPath,
            name: data.newPath.split("/").pop() || renamingItem.name,
          })
        }
      }
    } catch { /* ignore */ }
  }, [renamingItem, renameValue, fetchTree])

  const handleRenameCancel = useCallback(() => {
    setRenamingItem(null)
    setRenameValue("")
  }, [])

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
        <div className="px-2 py-1.5 border-b border-border/50">
          <div className="flex items-center gap-1.5 bg-elevation-0 border border-border rounded px-2 py-1">
            <Search className="size-3 text-muted-foreground/50 shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search files..."
              className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/40 outline-none min-w-0"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery("")} className="text-muted-foreground/50 hover:text-foreground">
                <X className="size-3" />
              </button>
            )}
          </div>
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
                    items={filteredCategories[cat]}
                    selectedPath={selectedFile?.path ?? null}
                    onSelect={handleSelect}
                    onNewFile={canCreate ? () => handleNewFile(cat) : undefined}
                    onDeleteItem={handleDeleteItem}
                    onRenameItem={handleStartRename}
                    renamingPath={renamingItem?.path ?? null}
                    renameValue={renameValue}
                    onRenameValueChange={setRenameValue}
                    onRenameSubmit={handleRenameSubmit}
                    onRenameCancel={handleRenameCancel}
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
