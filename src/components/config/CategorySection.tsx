import { useState } from "react"
import { Lock, Plus, Save, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { Category, ConfigItem } from "./config-types"
import { CATEGORY_META } from "./config-types"
import { ScopeBadge } from "./ScopeBadge"
import { NewFileDialog } from "./NewFileDialog"
import { ItemContextPopup } from "./ItemContextPopup"

interface CategorySectionProps {
  category: Category
  items: ConfigItem[]
  selectedPath: string | null
  onSelect: (item: ConfigItem) => void
  onNewFile?: () => void
  onDeleteItem: (item: ConfigItem) => void
  onRenameItem: (item: ConfigItem) => void
  renamingPath: string | null
  renameValue: string
  onRenameValueChange: (v: string) => void
  onRenameSubmit: () => void
  onRenameCancel: () => void
  creatingInCategory: { globalDir: string | null; projectDir: string | null; fileType: "command" | "skill" | "agent" } | null
  onCreated: (path: string, fileType: string, scope: string) => void
  onCancelCreate: () => void
}

export function CategorySection({
  category,
  items,
  selectedPath,
  onSelect,
  onNewFile,
  onDeleteItem,
  onRenameItem,
  renamingPath,
  renameValue,
  onRenameValueChange,
  onRenameSubmit,
  onRenameCancel,
  creatingInCategory,
  onCreated,
  onCancelCreate,
}: CategorySectionProps) {
  const meta = CATEGORY_META[category]
  const Icon = meta.icon
  const [contextMenu, setContextMenu] = useState<{ item: ConfigItem; position: { x: number; y: number } } | null>(null)

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
        const isRenaming = renamingPath === item.path

        if (isRenaming) {
          return (
            <div key={item.path} className="flex items-center gap-1 px-3 py-1 border-l-2 border-blue-400 bg-blue-500/10">
              <input
                type="text"
                value={renameValue}
                onChange={(e) => onRenameValueChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onRenameSubmit()
                  if (e.key === "Escape") onRenameCancel()
                }}
                autoFocus
                className="flex-1 bg-elevation-0 border border-border rounded px-2 py-0.5 text-xs text-foreground outline-none focus:border-blue-500/50 min-w-0"
              />
              <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={onRenameSubmit} disabled={!renameValue.trim()}>
                <Save className="size-3 text-green-400" />
              </Button>
              <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={onRenameCancel}>
                <X className="size-3" />
              </Button>
            </div>
          )
        }

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
            onDoubleClick={(e) => {
              e.preventDefault()
              setContextMenu({ item, position: { x: e.clientX, y: e.clientY } })
            }}
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

      {/* Context popup */}
      {contextMenu && (
        <ItemContextPopup
          item={contextMenu.item}
          position={contextMenu.position}
          onRename={() => onRenameItem(contextMenu.item)}
          onDelete={() => onDeleteItem(contextMenu.item)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
