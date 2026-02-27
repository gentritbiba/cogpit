import { useState, useRef, useCallback } from "react"
import { Send, Loader2, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { authFetch } from "@/lib/auth"
import type { TeamMember } from "@/lib/team-types"
import { getMemberColorClass, getMemberEffectiveColor } from "@/lib/team-types"

interface TeamChatInputProps {
  teamName: string
  members: TeamMember[]
}

export function TeamChatInput({ teamName, members }: TeamChatInputProps) {
  const [text, setText] = useState("")
  const [selectedMember, setSelectedMember] = useState<string | null>(null)
  const [showDropdown, setShowDropdown] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const handleSend = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed || !selectedMember || sending) return

    setSending(true)
    setError(null)

    try {
      const res = await authFetch(
        `/api/team-message/${encodeURIComponent(teamName)}/${encodeURIComponent(selectedMember)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed }),
        }
      )
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || "Failed to send")
      } else {
        setText("")
        if (textareaRef.current) {
          textareaRef.current.style.height = "auto"
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error")
    } finally {
      setSending(false)
    }
  }, [text, selectedMember, teamName, sending])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value)
      const el = e.target
      el.style.height = "auto"
      el.style.height = Math.min(el.scrollHeight, 160) + "px"
    },
    []
  )

  const selected = members.find((m) => m.name === selectedMember)

  function getPlaceholder(): string {
    if (!selectedMember) return "Select a team member first..."
    if (sending) return "Sending..."
    return `Message ${selectedMember}... (Enter to send)`
  }

  return (
    <div className="border-t border-border/40 bg-elevation-2 px-4 py-2">
      <div className="flex items-end gap-2">
        {/* Member selector */}
        <div className="relative shrink-0" ref={dropdownRef}>
          <button
            onClick={() => setShowDropdown(!showDropdown)}
            className={cn(
              "flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs transition-colors",
              selectedMember
                ? "border-border/50 text-foreground hover:border-border/70"
                : "border-border/50 text-muted-foreground hover:border-border/70"
            )}
          >
            {selected && (
              <span
                className={cn(
                  "inline-flex h-2 w-2 shrink-0 rounded-full",
                  getMemberColorClass(getMemberEffectiveColor(selected))
                )}
              />
            )}
            <span className="max-w-[100px] truncate">
              {selectedMember || "Select member"}
            </span>
            <ChevronDown className="size-3 text-muted-foreground" />
          </button>

          {showDropdown && (
            <div className="absolute bottom-full left-0 mb-1 w-48 rounded-lg border border-border/50 bg-elevation-1 py-1 depth-high z-50">
              {members.map((m) => (
                  <button
                    key={m.name}
                    onClick={() => {
                      setSelectedMember(m.name)
                      setShowDropdown(false)
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-elevation-2",
                      selectedMember === m.name
                        ? "text-foreground"
                        : "text-muted-foreground"
                    )}
                  >
                    <span
                      className={cn(
                        "inline-flex h-2 w-2 shrink-0 rounded-full",
                        getMemberColorClass(getMemberEffectiveColor(m))
                      )}
                    />
                    <span className="truncate">{m.name}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {m.agentType}
                    </span>
                  </button>
                ))}
            </div>
          )}
        </div>

        {/* Text input */}
        <div className="relative flex-1">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={getPlaceholder()}
            disabled={!selectedMember || sending}
            rows={1}
            className={cn(
              "w-full resize-none rounded-lg border bg-elevation-0 px-3 py-2 text-sm text-foreground",
              "placeholder:text-muted-foreground focus:outline-none focus:ring-1",
              !selectedMember || sending
                ? "border-border/50 opacity-60 cursor-not-allowed"
                : "border-border/50 focus:ring-blue-500/40"
            )}
          />
          {sending && (
            <div className="absolute right-2 top-1/2 -translate-y-1/2">
              <Loader2 className="size-4 animate-spin text-blue-400" />
            </div>
          )}
        </div>

        {/* Send button */}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 shrink-0 p-0"
          disabled={!text.trim() || !selectedMember || sending}
          onClick={handleSend}
        >
          <Send className="size-4" />
        </Button>
      </div>
      {error && (
        <p className="mt-1 text-[10px] text-red-400">{error}</p>
      )}
    </div>
  )
}
