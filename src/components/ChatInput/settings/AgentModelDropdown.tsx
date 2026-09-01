import { ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { AgentKind } from "@/lib/sessionSource"
import { AGENT_OPTIONS } from "./modelOptions"
import { DropdownOptionItem } from "./DropdownOptionItem"
import type { DropdownOption } from "./types"

interface AgentModelDropdownProps {
  agentKind: AgentKind
  onAgentKindChange: (agentKind: AgentKind) => void
  value: string
  fallbackLabel: string
  options: readonly DropdownOption[]
  onChange: (value: string) => void
}

export function AgentModelDropdown({
  agentKind,
  onAgentKindChange,
  value,
  fallbackLabel,
  options,
  onChange,
}: AgentModelDropdownProps) {
  const agentLabel = AGENT_OPTIONS.find((option) => option.value === agentKind)?.label ?? agentKind
  const selectedLabel = options.find((option) => option.value === value)?.label ?? fallbackLabel

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="xs" />}>
        <span className="truncate">{`${agentLabel} / ${selectedLabel}`}</span>
        <ChevronDown data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label="Agent and model" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Agent</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={agentKind}
            onValueChange={(nextAgent) => onAgentKindChange(nextAgent as AgentKind)}
          >
            {AGENT_OPTIONS.map((option) => {
              const Icon = option.Icon
              return (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  <Icon />
                  {option.label}
                </DropdownMenuRadioItem>
              )
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Model</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
            {options.map((option) => (
              <DropdownOptionItem
                key={option.value}
                option={option}
                descriptionWidth="max-w-72"
              />
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
