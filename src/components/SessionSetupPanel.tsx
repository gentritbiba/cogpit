import { Cpu } from "lucide-react"
import { cn, MODEL_OPTIONS } from "@/lib/utils"

interface SessionSetupPanelProps {
  permissionsPanel?: React.ReactNode
  selectedModel?: string
  onModelChange?: (model: string) => void
}

export function SessionSetupPanel({
  permissionsPanel,
  selectedModel,
  onModelChange,
}: SessionSetupPanelProps) {
  return (
    <aside className="shrink-0 w-[300px] border-l border-zinc-800 bg-zinc-950 overflow-y-auto h-full panel-enter-right">
      <div className="flex flex-col gap-6 p-3">
        {/* Permissions */}
        {permissionsPanel && (
          <div className="rounded-lg border border-zinc-800 p-3">
            {permissionsPanel}
          </div>
        )}

        {/* Model Selector */}
        {onModelChange && (
          <div className="rounded-lg border border-zinc-800 p-3">
            <section>
              <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
                <span className="h-3.5 w-0.5 rounded-full bg-blue-500/40" />
                <Cpu className="size-3" />
                Model
              </h3>
              <div className="grid grid-cols-2 gap-1">
                {MODEL_OPTIONS.map((opt) => {
                  const isSelected = (selectedModel || "") === opt.value
                  return (
                    <button
                      key={opt.value}
                      onClick={() => onModelChange(opt.value)}
                      className={cn(
                        "rounded-md border px-2 py-1.5 text-[10px] font-medium transition-all",
                        isSelected
                          ? "border-blue-500 text-blue-400 bg-blue-500/10"
                          : "border-zinc-800 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300 bg-zinc-900/50"
                      )}
                    >
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            </section>
          </div>
        )}
      </div>
    </aside>
  )
}
