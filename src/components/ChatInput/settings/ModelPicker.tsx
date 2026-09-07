import { useId, type ReactNode } from "react"
import { Sparkles, Zap } from "lucide-react"
import { Popover, PopoverTrigger } from "@/components/ui/popover"
import { Toggle } from "@/components/ui/toggle"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { capabilitiesFor, type AgentKind } from "@/lib/agents"
import { loadModelCatalog } from "@/hooks/useModelOptions"
import { cn, type ServiceTierOption } from "@/lib/utils"
import { AGENT_OPTIONS } from "./modelOptions"
import {
  PickerChip,
  PickerList,
  PickerOption,
  PickerPanel,
  PickerSectionLabel,
  pickerSideFor,
} from "./PickerShell"
import type { SettingOption } from "./types"

interface ModelPickerProps {
  agentKind: AgentKind
  /** Absent once a session exists: its provider cannot change. */
  onAgentKindChange?: (agentKind: AgentKind) => void
  selectedModel: string
  resolvedDefaultName: string
  modelOptions: readonly SettingOption[]
  onModelChange: (model: string) => void
  /** Already normalised to one of `effortOptions`, or "" when there are none. */
  selectedEffort: string
  effortOptions: readonly SettingOption[]
  onEffortChange: (effort: string) => void
  fastTier?: ServiceTierOption
  fastModeEnabled?: boolean
  onFastModeEnabledChange?: (enabled: boolean) => void
  ultracodeEnabled?: boolean
  /** Absent when the selected model cannot run Ultracode. */
  onUltracodeEnabledChange?: (enabled: boolean) => void
  isNewSession: boolean
}

export function ModelPicker({
  agentKind,
  onAgentKindChange,
  selectedModel,
  resolvedDefaultName,
  modelOptions,
  onModelChange,
  selectedEffort,
  effortOptions,
  onEffortChange,
  fastTier,
  fastModeEnabled = false,
  onFastModeEnabledChange,
  ultracodeEnabled = false,
  onUltracodeEnabledChange,
  isNewSession,
}: ModelPickerProps) {
  const capabilities = capabilitiesFor(agentKind)
  const provider = AGENT_OPTIONS.find((option) => option.value === agentKind)
  const ProviderIcon = provider?.Icon
  const providerLabel = provider?.label ?? agentKind
  const modelLabel = modelOptions.find((option) => option.value === selectedModel)?.label ?? resolvedDefaultName
  const selectedEffortOption = effortOptions.find((option) => option.value === selectedEffort)
  const providerLocked = !onAgentKindChange

  // A row for every option the provider has, greyed out when the selected
  // model lacks it, so switching models explains what changed instead of
  // silently dropping a control.
  const showEffort = capabilities.reasoningEffort
  const showFast = capabilities.fastTier
  const showUltracode = capabilities.ultracode
  const fastAvailable = !!fastTier && !!onFastModeEnabledChange
  const ultracodeAvailable = !!onUltracodeEnabledChange
  const fastOn = fastModeEnabled && fastAvailable
  const ultracodeOn = ultracodeEnabled && ultracodeAvailable

  const effortCaption = ultracodeOn
    ? "Pinned by Ultracode"
    : selectedEffortOption?.description

  const chipLabel = [providerLabel, modelLabel, selectedEffortOption?.label].filter(Boolean).join(" · ")
  const chipState = [
    fastOn ? "Fast mode on" : null,
    ultracodeOn ? "Ultracode on" : null,
  ].filter(Boolean).join(", ")

  const providerLabelId = useId()
  const modelLabelId = useId()
  const effortLabelId = useId()

  return (
    <Popover modal={false} onOpenChange={(open) => { if (open) void loadModelCatalog() }}>
      <PopoverTrigger
        render={(
          <PickerChip
            aria-label={chipState ? `${chipLabel} (${chipState})` : chipLabel}
            title={chipState ? `${chipLabel} · ${chipState}` : undefined}
          />
        )}
      >
        {ProviderIcon && <ProviderIcon data-icon="inline-start" />}
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate">{modelLabel}</span>
          {selectedEffortOption && (
            <>
              <span className="text-muted-foreground/60" aria-hidden>·</span>
              <span className="shrink-0 text-muted-foreground">{selectedEffortOption.label}</span>
            </>
          )}
        </span>
        {fastOn && <Zap className="size-3 shrink-0 fill-current" aria-hidden />}
        {ultracodeOn && <Sparkles className="size-3 shrink-0 fill-current" aria-hidden />}
      </PopoverTrigger>

      <PickerPanel
        side={pickerSideFor(isNewSession)}
        align="end"
        aria-label="Model settings"
        className="w-[34rem] max-w-[calc(100vw-1.5rem)]"
      >
        <div className="grid min-h-0 flex-1 grid-cols-[10.5rem_minmax(0,1fr)] overflow-hidden">
          <div className="flex flex-col border-r bg-muted/30 p-1.5">
            <PickerSectionLabel id={providerLabelId}>Provider</PickerSectionLabel>
            <PickerList
              value={agentKind}
              onValueChange={(next) => onAgentKindChange?.(next)}
              aria-labelledby={providerLabelId}
            >
              {AGENT_OPTIONS.map((option) => (
                <PickerOption
                  key={option.value}
                  value={option.value}
                  title={option.label}
                  icon={option.Icon}
                  disabled={providerLocked && option.value !== agentKind}
                />
              ))}
            </PickerList>
            {providerLocked && (
              <p className="mt-auto px-2 pb-1 pt-3 text-[11px] leading-4 text-muted-foreground">
                Fixed for this session. Start a new one to switch.
              </p>
            )}
          </div>

          <div className="flex min-h-0 flex-col p-1.5">
            <div className="flex items-center justify-between gap-2 pr-0.5">
              <PickerSectionLabel id={modelLabelId}>Model</PickerSectionLabel>
              {(showFast || showUltracode) && (
                <div className="flex items-center gap-1">
                  {showFast && (
                    <ModeToggle
                      label="Fast mode"
                      pressed={fastOn}
                      onPressedChange={(next) => onFastModeEnabledChange?.(next)}
                      disabled={!fastAvailable}
                      title={fastAvailable
                        ? `Fast mode · ${fastTier?.description ?? "Lower latency with increased usage"}`
                        : `Fast mode isn't offered for ${modelLabel}`}
                    >
                      <Zap className={cn(fastOn && "fill-current")} />
                    </ModeToggle>
                  )}
                  {showUltracode && (
                    <ModeToggle
                      label="Ultracode"
                      pressed={ultracodeOn}
                      onPressedChange={(next) => onUltracodeEnabledChange?.(next)}
                      disabled={!ultracodeAvailable}
                      title={ultracodeAvailable
                        ? "Ultracode · Extra High effort with standing multi-agent orchestration"
                        : `Ultracode isn't available for ${modelLabel}`}
                    >
                      <Sparkles className={cn(ultracodeOn && "fill-current")} />
                      Ultracode
                    </ModeToggle>
                  )}
                </div>
              )}
            </div>
            <PickerList
              value={selectedModel}
              onValueChange={onModelChange}
              aria-labelledby={modelLabelId}
              className="max-h-56 min-h-0 flex-1 overflow-y-auto"
            >
              {modelOptions.map((option) => (
                <PickerOption
                  key={option.value}
                  value={option.value}
                  title={option.menuLabel ?? option.label}
                  description={option.description}
                />
              ))}
            </PickerList>
          </div>
        </div>

        {showEffort && (
          <div className="shrink-0 border-t p-3 pt-2">
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <PickerSectionLabel id={effortLabelId} className="p-0">Reasoning effort</PickerSectionLabel>
              {effortCaption && (
                <span className="truncate text-[11px] leading-4 text-muted-foreground">{effortCaption}</span>
              )}
            </div>
            {effortOptions.length > 0
              ? (
                <ToggleGroup
                  value={[selectedEffort]}
                  onValueChange={([next]) => { if (next) onEffortChange(next) }}
                  disabled={ultracodeOn}
                  variant="outline"
                  size="sm"
                  spacing={0}
                  aria-labelledby={effortLabelId}
                  className="w-full"
                >
                  {effortOptions.map((option) => (
                    <ToggleGroupItem
                      key={option.value}
                      value={option.value}
                      title={option.description}
                      className={cn(
                        "min-w-0 flex-1 px-1 text-xs",
                        "data-pressed:bg-primary data-pressed:text-primary-foreground data-pressed:hover:bg-primary/90",
                      )}
                    >
                      <span className="truncate">{option.label}</span>
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              )
              : (
                <p className="text-xs leading-5 text-muted-foreground">
                  Not adjustable for {modelLabel}.
                </p>
              )}
          </div>
        )}
      </PickerPanel>
    </Popover>
  )
}

interface ModeToggleProps {
  label: string
  pressed: boolean
  onPressedChange: (pressed: boolean) => void
  disabled?: boolean
  title?: string
  children: ReactNode
}

/** A compact on/off chip for a session mode, lit like a pressed effort segment. */
function ModeToggle({ label, pressed, onPressedChange, disabled, title, children }: ModeToggleProps) {
  return (
    <Toggle
      variant="outline"
      size="sm"
      pressed={pressed}
      onPressedChange={onPressedChange}
      disabled={disabled}
      aria-label={label}
      title={title}
      className="h-6 gap-1 px-1.5 text-xs text-muted-foreground data-pressed:bg-primary data-pressed:text-primary-foreground data-pressed:hover:bg-primary/90 [&_svg:not([class*='size-'])]:size-3.5"
    >
      {children}
    </Toggle>
  )
}
