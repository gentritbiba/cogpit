import { RotateCcw, GitFork, Copy } from "lucide-react"
import type { Branch } from "../../shared/session/types"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

interface TurnContextMenuProps {
  children: React.ReactNode
  turnIndex: number
  branches: Branch[]
  onRestoreToHere: (turnIndex: number) => void
  onOpenBranches: (turnIndex: number) => void
  onBranchFromHere?: (turnIndex: number) => void
}

export function TurnContextMenu({
  children,
  turnIndex,
  branches,
  onRestoreToHere,
  onOpenBranches,
  onBranchFromHere,
}: TurnContextMenuProps) {
  return (
    <ContextMenu>
      {/* Overrides the trigger's default select-none: transcript text must stay copyable. */}
      <ContextMenuTrigger className="select-text">{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        <ContextMenuGroup>
          <ContextMenuItem onClick={() => onRestoreToHere(turnIndex)}>
            <RotateCcw data-icon="inline-start" />
            Restore to this point
          </ContextMenuItem>
        </ContextMenuGroup>
        {branches.length > 0 && (
          <>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem onClick={() => onOpenBranches(turnIndex)}>
                <GitFork data-icon="inline-start" />
                View branches ({branches.length})
              </ContextMenuItem>
            </ContextMenuGroup>
          </>
        )}
        {onBranchFromHere && (
          <>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem onClick={() => onBranchFromHere(turnIndex)}>
                <Copy data-icon="inline-start" />
                Duplicate from here
              </ContextMenuItem>
            </ContextMenuGroup>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
