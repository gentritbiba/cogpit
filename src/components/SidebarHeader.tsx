import { memo } from "react"
import { Eye, PanelLeftClose, Search } from "lucide-react"
import { HeaderIconButton } from "@/components/header-shared"

interface SidebarHeaderProps {
  onToggleSidebar: () => void
  onGoHome: () => void
  onOpenCommandPalette: () => void
  sidebarShortcut: string
  commandPaletteShortcut: string
}

/**
 * With no title bar, the sidebar's top row owns the window's top-left corner:
 * traffic-light inset, home on the left, and the two actions that leave the
 * sidebar pinned to its right edge.
 */
export const SidebarHeader = memo(function SidebarHeader({
  onToggleSidebar,
  onGoHome,
  onOpenCommandPalette,
  sidebarShortcut,
  commandPaletteShortcut,
}: SidebarHeaderProps) {
  return (
    <div className="electron-drag window-inset-start flex h-12 shrink-0 items-center gap-1 px-2">
      <HeaderIconButton icon={Eye} label="Home" onClick={onGoHome} size="default" />
      <div className="flex-1" />
      <HeaderIconButton
        icon={Search}
        label={`Search (${commandPaletteShortcut})`}
        onClick={onOpenCommandPalette}
        size="default"
      />
      <HeaderIconButton
        icon={PanelLeftClose}
        label={`Hide sidebar (${sidebarShortcut})`}
        onClick={onToggleSidebar}
        size="default"
      />
    </div>
  )
})
