import { Lock, Plus, Save, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { Category, ConfigItem } from "./config-types"
import { CATEGORY_META } from "./config-types"
import { ScopeBadge } from "./ScopeBadge"
import { CliBadge } from "./CliBadge"
import { LinkIndicator } from "./LinkIndicator"
import { NewFileDialog } from "./NewFileDialog"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

interface CategorySectionProps {
  category: Category
  items: ConfigItem[]
  selectedPath: string | null
  onSelect: (item: ConfigItem) => void
  onNewFile?: () => void
  onDeleteItem?: (item: ConfigItem) => void
  onRenameItem?: (item: ConfigItem) => void
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

  if (items.length === 0 && !onNewFile) return null

  return (
    <section>
      <div className="group flex h-8 items-center gap-1.5 px-3">
        <Icon data-icon="inline-start" className={cn("size-3.5", meta.color)} />
        <span className="flex-1 text-xs font-medium text-muted-foreground">{meta.label}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{items.length}</span>
        {onNewFile && (
          <Tooltip>
            <TooltipTrigger render={<Button
                variant="ghost"
                size="icon-xs"
                className="opacity-0 transition-opacity group-hover:opacity-100"
                aria-label={`New ${category.slice(0, -1)}`}
                onClick={onNewFile}
              />}>
                <Plus data-icon="inline-start" />
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
            <div key={item.path} className="flex items-center gap-1 border-l-2 border-foreground/30 bg-accent px-3 py-1">
              <Input
                value={renameValue}
                onChange={(e) => onRenameValueChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onRenameSubmit()
                  if (e.key === "Escape") onRenameCancel()
                }}
                autoFocus
                className="h-7 min-w-0 flex-1 text-xs"
              />
              <Button variant="ghost" size="icon-xs" aria-label="Save name" onClick={onRenameSubmit} disabled={!renameValue.trim()}>
                <Save data-icon="inline-start" />
              </Button>
              <Button variant="ghost" size="icon-xs" aria-label="Cancel rename" onClick={onRenameCancel}>
                <X data-icon="inline-start" />
              </Button>
            </div>
          )
        }

        const itemContent = (
          <>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm">{item.name}</span>
                <LinkIndicator linkTarget={item.linkTarget} />
                {item.readOnly && <Lock className="size-2.5 shrink-0 text-muted-foreground/40" />}
              </div>
              {item.description && (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{item.description}</p>
              )}
            </div>
            <CliBadge cli={item.cli} />
            <ScopeBadge scope={item.scope} pluginName={item.pluginName} />
          </>
        )

        const itemClassName = cn(
          "flex w-full items-center gap-2 border-l-2 px-3 py-2 text-left text-sm transition-colors",
          isSelected
            ? "border-foreground/30 bg-accent text-accent-foreground"
            : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
        )

        if (!onDeleteItem || !onRenameItem) {
          return (
            <button
              type="button"
              key={item.path}
              className={itemClassName}
              onClick={() => onSelect(item)}
            >
              {itemContent}
            </button>
          )
        }

        return (
          <ContextMenu key={item.path}>
            <ContextMenuTrigger
              render={(
                <button
                  type="button"
                  className={itemClassName}
                  onClick={() => onSelect(item)}
                />
              )}
            >
              {itemContent}
            </ContextMenuTrigger>
            <ContextMenuContent className="min-w-36">
              {item.readOnly ? (
                <ContextMenuGroup>
                  <ContextMenuLabel>Read-only file</ContextMenuLabel>
                </ContextMenuGroup>
              ) : (
                <>
                  <ContextMenuGroup>
                    <ContextMenuItem onClick={() => onRenameItem(item)}>
                      Rename
                    </ContextMenuItem>
                  </ContextMenuGroup>
                  <ContextMenuSeparator />
                  <ContextMenuGroup>
                    <ContextMenuItem
                      variant="destructive"
                      onClick={() => onDeleteItem(item)}
                    >
                      Delete
                    </ContextMenuItem>
                  </ContextMenuGroup>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>
        )
      })}

      {items.length === 0 && !creatingInCategory && (
        <p className="px-3 py-1 text-xs text-muted-foreground">None configured</p>
      )}

      {creatingInCategory && (
        <NewFileDialog
          globalDir={creatingInCategory.globalDir}
          projectDir={creatingInCategory.projectDir}
          fileType={creatingInCategory.fileType}
          onCreated={onCreated}
          onCancel={onCancelCreate}
        />
      )}
    </section>
  )
}
