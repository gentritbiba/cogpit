import { useState, useRef, useCallback } from "react"
import { Send, Loader2, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { authFetch } from "@/lib/auth"
import type { TeamMember } from "@/lib/team-types"
import { getMemberColorClass } from "@/lib/team-types"

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
  const isLead = selected?.agentType === "team-lead"

  return (
    <div className="border-t border-zinc-800 bg-zinc-900/80 px-4 py-2">
      <div className="flex items-end gap-2">
        {/* Member selector */}
        <div className="relative shrink-0" ref={dropdownRef}>
          <button
            onClick={() => setShowDropdown(!showDropdown)}
            className={cn(
              "flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs transition-colors",
              selectedMember
                ? "border-zinc-700 text-zinc-300 hover:border-zinc-600"
                : "border-zinc-700 text-zinc-500 hover:border-zinc-600"
            )}
          >
            {selected && (
              <span
                className={cn(
                  "inline-flex h-2 w-2 shrink-0 rounded-full",
                  getMemberColorClass(isLead ? undefined : selected.color)
                )}
              />
            )}
            <span className="max-w-[100px] truncate">
              {selectedMember || "Select member"}
            </span>
            <ChevronDown className="size-3 text-zinc-500" />
          </button>

          {showDropdown && (
            <div className="absolute bottom-full left-0 mb-1 w-48 rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-lg z-50">
              {members.map((m) => {
                const mIsLead = m.agentType === "team-lead"
                return (
                  <button
                    key={m.name}
                    onClick={() => {
                      setSelectedMember(m.name)
                      setShowDropdown(false)
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-zinc-800",
                      selectedMember === m.name
                        ? "text-zinc-200"
                        : "text-zinc-400"
                    )}
                  >
                    <span
                      className={cn(
                        "inline-flex h-2 w-2 shrink-0 rounded-full",
                        getMemberColorClass(mIsLead ? undefined : m.color)
                      )}
                    />
                    <span className="truncate">{m.name}</span>
                    <span className="ml-auto text-[10px] text-zinc-600">
                      {m.agentType}
                    </span>
                  </button>
                )
              })}
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
            placeholder={
              !selectedMember
                ? "Select a team member first..."
                : sending
                  ? "Sending..."
                  : `Message ${selectedMember}... (Enter to send)`
            }
            disabled={!selectedMember || sending}
            rows={1}
            className={cn(
              "w-full resize-none rounded-lg border bg-zinc-950 px-3 py-2 text-sm text-zinc-100",
              "placeholder:text-zinc-600 focus:outline-none focus:ring-1",
              !selectedMember || sending
                ? "border-zinc-700 opacity-60 cursor-not-allowed"
                : "border-zinc-700 focus:ring-blue-500/40"
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
