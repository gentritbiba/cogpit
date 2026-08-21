import { useState, useEffect, useCallback, useRef, memo } from "react"
import { Search, X } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { authFetch } from "@/lib/auth"
import { useCapability } from "@/hooks/useCapability"
import type { ConfigTreeSection, Category, ConfigItem } from "@/components/config/config-types"
import { CATEGORY_ORDER, CATEGORY_DIR_MAP, flattenItems, categorizeItems } from "@/components/config/config-types"
import { CategorySection } from "@/components/config/CategorySection"
import { ConfigEditor } from "@/components/config/ConfigEditor"
import { EmptyState } from "@/components/config/EmptyState"

// ── Helpers ─────────────────────────────────────────────────────────────

/** Lets "claude", "codex" and "unlinked" narrow to one CLI's view of the config. */
function cliSearchText(item: ConfigItem): string {
  if (!item.cli) return ""
  return item.cli.length > 0 ? item.cli.join(" ") : "unlinked"
}

function filterItemsByQuery(items: ConfigItem[], query: string): ConfigItem[] {
  if (!query) return items
  const q = query.toLowerCase()
  return items.filter((item) => {
    const haystack = [
      item.name,
      item.description,
      item.path,
      item.linkTarget ?? "",
      cliSearchText(item),
    ]
    return haystack.some((field) => field.toLowerCase().includes(q))
  })
}

// ── Main component ──────────────────────────────────────────────────────

interface ConfigBrowserProps {
  projectPath: string | null
  initialFilePath?: string | null
}

export const ConfigBrowser = memo(function ConfigBrowser({ projectPath, initialFilePath }: ConfigBrowserProps) {
  const canWriteConfig = useCapability("configWrite")
  const [sections, setSections] = useState<ConfigTreeSection[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedFile, setSelectedFile] = useState<ConfigItem | null>(null)
  const [creating, setCreating] = useState<{ category: Category; globalDir: string | null; projectDir: string | null; fileType: "command" | "skill" | "agent" } | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [renamingItem, setRenamingItem] = useState<ConfigItem | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [pendingDeleteItem, setPendingDeleteItem] = useState<ConfigItem | null>(null)
  const initialFileLoadedRef = useRef(false)

  // Fetch tree
  const fetchTree = useCallback(async () => {
    if (!canWriteConfig) {
      setSections([])
      setSelectedFile(null)
      setLoading(false)
      return
    }
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
  }, [canWriteConfig, projectPath])

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
    if (!canWriteConfig) return
    if (!globalBaseDir && !projectBaseDir) return
    const mapping = CATEGORY_DIR_MAP[category]
    if (!mapping) return

    setCreating({
      category,
      globalDir: globalBaseDir ? `${globalBaseDir}/${mapping.subdir}` : null,
      projectDir: projectBaseDir ? `${projectBaseDir}/${mapping.subdir}` : null,
      fileType: mapping.fileType,
    })
  }, [canWriteConfig, globalBaseDir, projectBaseDir])

  const handleDeleteItem = useCallback((item: ConfigItem) => {
    if (!canWriteConfig || item.readOnly) return
    setPendingDeleteItem(item)
  }, [canWriteConfig])

  const confirmDeleteItem = useCallback(async () => {
    if (!canWriteConfig || !pendingDeleteItem || pendingDeleteItem.readOnly) return
    const item = pendingDeleteItem
    setPendingDeleteItem(null)
    try {
      const res = await authFetch(`/api/config-browser/file?path=${encodeURIComponent(item.path)}`, { method: "DELETE" })
      if (res.ok) {
        if (selectedFile?.path === item.path) setSelectedFile(null)
        fetchTree()
      }
    } catch { /* ignore */ }
  }, [canWriteConfig, fetchTree, pendingDeleteItem, selectedFile])

  const handleStartRename = useCallback((item: ConfigItem) => {
    if (!canWriteConfig || item.readOnly) return
    const name = item.name === "SKILL.md"
      ? item.path.split("/").slice(-2, -1)[0] || item.name
      : item.name.replace(/\.[^.]+$/, "")
    setRenamingItem(item)
    setRenameValue(name)
  }, [canWriteConfig])

  const handleRenameSubmit = useCallback(async () => {
    if (!canWriteConfig || !renamingItem || !renameValue.trim()) return
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
  }, [canWriteConfig, renamingItem, renameValue, fetchTree])

  const handleRenameCancel = useCallback(() => {
    setRenamingItem(null)
    setRenameValue("")
  }, [])

  if (!canWriteConfig) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Server configuration is available to administrators only.
      </div>
    )
  }

  return (
    <div className="flex flex-1 min-h-0 min-w-0">
      <div className="flex min-h-0 w-80 shrink-0 flex-col border-r bg-sidebar">
        <div className="flex h-11 items-center gap-2 border-b px-3">
          <span className="text-sm font-medium text-foreground">Configuration</span>
          {projectPath && (
            <span className="ml-auto truncate text-xs text-muted-foreground" title={projectPath}>
              {projectPath.split("/").pop()}
            </span>
          )}
        </div>
        <div className="border-b p-2">
          <InputGroup>
            <InputGroupAddon>
              <Search data-icon="inline-start" />
            </InputGroupAddon>
            <InputGroupInput
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search configuration"
            />
            {searchQuery && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  aria-label="Clear search"
                  onClick={() => setSearchQuery("")}
                >
                  <X data-icon="inline-start" />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
        </div>
        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-1 py-2">
            {loading ? (
              <div className="flex flex-col gap-2 px-3 py-2" aria-label="Loading configuration">
                {Array.from({ length: 6 }, (_, index) => (
                  <Skeleton key={index} className="h-8 w-full" />
                ))}
              </div>
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
                    onNewFile={canWriteConfig && canCreate ? () => handleNewFile(cat) : undefined}
                    onDeleteItem={canWriteConfig ? handleDeleteItem : undefined}
                    onRenameItem={canWriteConfig ? handleStartRename : undefined}
                    renamingPath={renamingItem?.path ?? null}
                    renameValue={renameValue}
                    onRenameValueChange={setRenameValue}
                    onRenameSubmit={handleRenameSubmit}
                    onRenameCancel={handleRenameCancel}
                    creatingInCategory={canWriteConfig && creating?.category === cat ? creating : null}
                    onCreated={handleFileCreated}
                    onCancelCreate={() => setCreating(null)}
                  />
                )
              })
            )}
          </div>
        </ScrollArea>
      </div>

      {selectedFile ? (
        <ConfigEditor file={selectedFile} onDeleted={handleDeleted} readOnly={!canWriteConfig} />
      ) : (
        <EmptyState />
      )}

      <AlertDialog
        open={pendingDeleteItem !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setPendingDeleteItem(null)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete configuration file?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete "{pendingDeleteItem?.name}" permanently? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" size="sm" onClick={() => void confirmDeleteItem()}>
              Delete file
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
})
