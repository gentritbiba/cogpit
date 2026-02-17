import * as ContextMenu from "@radix-ui/react-context-menu"
import { RotateCcw, GitFork } from "lucide-react"
import type { Branch } from "@/lib/types"

interface TurnContextMenuProps {
  children: React.ReactNode
  turnIndex: number
  branches: Branch[]
  onRestoreToHere: (turnIndex: number) => void
  onOpenBranches: (turnIndex: number) => void
}

export function TurnContextMenu({
  children,
  turnIndex,
  branches,
  onRestoreToHere,
  onOpenBranches,
}: TurnContextMenuProps) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-[180px] rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-xl">
          <ContextMenu.Item
            className="flex items-center gap-2 rounded px-2.5 py-1.5 text-sm text-zinc-300 outline-none cursor-pointer hover:bg-zinc-800 hover:text-zinc-100"
            onSelect={() => onRestoreToHere(turnIndex)}
          >
            <RotateCcw className="size-3.5" />
            Restore to this point
          </ContextMenu.Item>
          {branches.length > 0 && (
            <>
              <ContextMenu.Separator className="my-1 h-px bg-zinc-800" />
              <ContextMenu.Item
                className="flex items-center gap-2 rounded px-2.5 py-1.5 text-sm text-zinc-300 outline-none cursor-pointer hover:bg-zinc-800 hover:text-zinc-100"
                onSelect={() => onOpenBranches(turnIndex)}
              >
                <GitFork className="size-3.5" />
                View branches ({branches.length})
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
