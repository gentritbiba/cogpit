import { Slider } from "@base-ui/react/slider"
import { cn } from "@/lib/utils"
import type { SettingOption } from "./types"

interface EffortSliderProps {
  options: readonly SettingOption[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  labelId: string
}

/**
 * The effort ladder as a discrete slider: one stop per level, the filled
 * track and lit ticks showing how far up the ladder the session sits.
 */
export function EffortSlider({ options, value, onChange, disabled, labelId }: EffortSliderProps) {
  const last = options.length - 1
  const index = Math.max(0, options.findIndex((option) => option.value === value))

  return (
    <Slider.Root
      value={index}
      min={0}
      max={last}
      step={1}
      disabled={disabled}
      onValueChange={(next) => {
        const option = options[next]
        if (option && option.value !== value) onChange(option.value)
      }}
      className={cn("w-full", disabled && "opacity-50")}
    >
      <Slider.Control className="flex h-6 w-full touch-none select-none items-center px-1.5">
        <Slider.Track className="relative h-1 w-full rounded-full bg-muted-foreground/20">
          <Slider.Indicator className="rounded-full bg-primary" />
          {options.map((option, tick) => (
            <span
              key={option.value}
              aria-hidden
              className={cn(
                "pointer-events-none absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-150",
                tick <= index ? "bg-primary" : "bg-muted-foreground/40",
              )}
              style={{ left: last === 0 ? "50%" : `${(tick / last) * 100}%` }}
            />
          ))}
          <Slider.Thumb
            aria-labelledby={labelId}
            getAriaValueText={(_, next) => options[next]?.label ?? ""}
            className="size-3.5 rounded-full bg-primary shadow-[0_0_0_3px_var(--popover)] outline-none transition-transform duration-100 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-popover data-dragging:scale-125 motion-reduce:transition-none"
          />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  )
}
