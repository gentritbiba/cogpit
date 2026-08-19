import { ChevronDown, Shield } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { PermissionMode } from "@/lib/permissions"
import type { AgentKind } from "@/lib/sessionSource"
import { getPermissionModeOptions } from "./permissionOptions"

interface PermissionDropdownProps {
  agentKind: AgentKind
  mode: PermissionMode
  onChange: (mode: PermissionMode) => void
  autoAvailable?: boolean
}

export function PermissionDropdown({
  agentKind,
  mode,
  onChange,
  autoAvailable = false,
}: PermissionDropdownProps) {
  const options = getPermissionModeOptions(agentKind, autoAvailable)
  const current = options.find((option) => option.value === mode) ?? options[0]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="xs" />}>
        <Shield data-icon="inline-start" />
        <span className="truncate">{current.label}</span>
        <ChevronDown data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label="Access policy" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Permissions</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={mode}
            onValueChange={(nextMode) => onChange(nextMode as PermissionMode)}
          >
            {options.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value} className="items-start py-2">
                <span className="flex min-w-0 flex-col items-start">
                  <span>{option.label}</span>
                  <span className="max-w-64 truncate text-xs font-normal text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
