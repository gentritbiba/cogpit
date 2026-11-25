import { forwardRef } from "react"
import { Laptop, Server } from "lucide-react"
import type { Machine } from "@/contexts/DevicePaneContext"
import { LOCAL_DEVICE_ID } from "@/lib/device"
import { cn } from "@/lib/utils"

// Registered as a number, so a slide can animate it smoothly instead of flipping it.
if (typeof CSS !== "undefined" && typeof CSS.registerProperty === "function") {
  try {
    CSS.registerProperty({ name: "--pager-to", syntax: "<number>", inherits: true, initialValue: "0" })
  } catch {
    // Registered already, by a hot reload.
  }
}

interface DevicePagerProps {
  machines: readonly Machine[]
  /** The machine on screen when the move began. */
  from: string
  /** The machine the move heads to; equal to `from` when at rest. */
  to: string
  visible: boolean
}

function MachineLabel({ machine, weight }: { machine: Machine | undefined; weight: string }) {
  if (!machine) return null
  const Icon = machine.id === LOCAL_DEVICE_ID ? Laptop : Server
  return (
    <span
      className="col-start-1 row-start-1 flex min-w-0 items-center justify-center gap-1.5"
      style={{ opacity: `calc(${weight} * 2 - 1)` }}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{machine.name}</span>
    </span>
  )
}

/**
 * The page dots shown while moving between machines: one per machine, the
 * current one drawn long, with its name above them. The stage sets
 * `--pager-to` (0 → 1) on this element as the machines move, under the
 * fingers and through a slide, so the long dot and the name travel with them.
 */
export const DevicePager = forwardRef<HTMLDivElement, DevicePagerProps>(function DevicePager(
  { machines, from, to, visible },
  ref,
) {
  const fromMachine = machines.find((machine) => machine.id === from)
  const toMachine = machines.find((machine) => machine.id === to)
  return (
    <div
      ref={ref}
      aria-hidden={!visible}
      data-visible={visible || undefined}
      className={cn(
        "pointer-events-none fixed top-3 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-1.5",
        "rounded-2xl border bg-popover/75 px-3.5 py-2 text-xs font-medium text-popover-foreground shadow-lg backdrop-blur-xl",
        "scale-95 opacity-0 transition-[opacity,scale] duration-200 ease-out data-visible:scale-100 data-visible:opacity-100",
        "motion-reduce:transition-none",
      )}
    >
      <span className="grid max-w-48">
        <MachineLabel machine={fromMachine} weight="(1 - var(--pager-to, 0))" />
        {to !== from && <MachineLabel machine={toMachine} weight="var(--pager-to, 0)" />}
      </span>
      <span className="flex items-center gap-1.5">
        {machines.map((machine) => {
          const weight = machine.id === from
            ? "(1 - var(--pager-to, 0))"
            : machine.id === to ? "var(--pager-to, 0)" : "0"
          return (
            <span
              key={machine.id}
              className="h-1.5 rounded-full bg-foreground"
              style={{
                width: `calc(0.375rem + 0.75rem * ${weight})`,
                opacity: `calc(0.25 + 0.75 * ${weight})`,
              }}
            />
          )
        })}
      </span>
      <span role="status" className="sr-only">{visible ? `Now on ${toMachine?.name ?? ""}` : ""}</span>
    </div>
  )
})
