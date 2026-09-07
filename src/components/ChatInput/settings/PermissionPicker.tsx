import { useId, useState } from "react"
import { Shield } from "lucide-react"
import { Popover, PopoverTrigger } from "@/components/ui/popover"
import type { PermissionMode } from "@/lib/permissions"
import type { AgentKind } from "@/lib/agents"
import { getPermissionModeOptions } from "./permissionOptions"
import { PickerChip, PickerList, PickerOption, PickerPanel, PickerSectionLabel, pickerSideFor } from "./PickerShell"

interface PermissionPickerProps {
  agentKind: AgentKind
  mode: PermissionMode
  onChange: (mode: PermissionMode) => void
  autoAvailable?: boolean
  isNewSession: boolean
}

export function PermissionPicker({
  agentKind,
  mode,
  onChange,
  autoAvailable = false,
  isNewSession,
}: PermissionPickerProps) {
  const [open, setOpen] = useState(false)
  const options = getPermissionModeOptions(agentKind, autoAvailable)
  const current = options.find((option) => option.value === mode) ?? options[0]
  const labelId = useId()

  return (
    <Popover modal={false} open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<PickerChip aria-label={`Permissions: ${current.label}`} />}>
        <Shield data-icon="inline-start" />
        <span className="truncate">{current.label}</span>
      </PopoverTrigger>
      <PickerPanel side={pickerSideFor(isNewSession)} aria-label="Permissions" className="w-80">
        <div className="p-1.5">
          <PickerSectionLabel id={labelId}>Permissions</PickerSectionLabel>
          <PickerList
            value={mode}
            onValueChange={(next) => {
              onChange(next)
              setOpen(false)
            }}
            aria-labelledby={labelId}
          >
            {options.map((option) => (
              <PickerOption
                key={option.value}
                value={option.value}
                title={option.label}
                description={option.description}
              />
            ))}
          </PickerList>
        </div>
      </PickerPanel>
    </Popover>
  )
}
