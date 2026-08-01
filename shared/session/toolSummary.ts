/**
 * One-line renderings of tool-call inputs.
 *
 * Shared because both the session timeline and the Mission Control summary
 * endpoint need the same phrasing for the same tool — a card saying something
 * different from the timeline for one tool call would read as a bug.
 */

/** Minimal shape needed to summarize a call — satisfied by a parsed ToolCall. */
export interface SummarizableToolCall {
  name: string
  input: Record<string, unknown>
}

export function getToolSummary(tc: SummarizableToolCall): string {
  const input = tc.input
  switch (tc.name) {
    case "Read":
    case "Write":
    case "Edit":
      return String(input.file_path ?? input.path ?? "")
    case "Bash":
      return String(input.command ?? input.cmd ?? "")
    case "Grep":
    case "Glob":
      return String(input.pattern ?? "")
    case "Task":
    case "Agent":
      return String(input.description ?? input.prompt ?? "")
    case "WebFetch":
      return String(input.url ?? "")
    case "WebSearch":
      return String(input.query ?? "")
    case "NotebookEdit":
      return String(input.notebook_path ?? "")
    case "EnterPlanMode":
      return "Entered plan mode"
    case "ExitPlanMode":
      return "Waiting for plan approval"
    case "AskUserQuestion": {
      const questions = input.questions as Array<{ question?: string }> | undefined
      return questions?.[0]?.question ?? ""
    }
    case "Monitor": {
      const bashId = String(input.bash_id ?? "")
      const filter = input.filter ? ` · filter=${input.filter}` : ""
      return `${bashId}${filter}`
    }
    case "CronCreate": {
      const sched = String(input.schedule ?? input.cron ?? "")
      const prompt = String(input.prompt ?? "")
      const trimmed = prompt.length > 60 ? prompt.slice(0, 60) + "..." : prompt
      return sched && trimmed ? `${sched} → ${trimmed}` : sched || trimmed
    }
    case "CronList":
      return ""
    case "CronDelete":
      return String(input.id ?? input.cron_id ?? "")
    case "ScheduleWakeup": {
      const sec = Number(input.delaySeconds ?? 0)
      const m = Math.round(sec / 60)
      const human = sec >= 3600 ? `${Math.round(sec / 3600)}h` : sec >= 60 ? `${m}m` : `${sec}s`
      const reason = input.reason ? ` · ${input.reason}` : ""
      return `in ${human}${reason}`
    }
    case "RemoteTrigger": {
      const action = String(input.action ?? "")
      const id = String(input.id ?? input.trigger_id ?? "")
      return [action, id].filter(Boolean).join(" ")
    }
    case "PushNotification":
      return String(input.title ?? input.body ?? "")
    case "EnterWorktree": {
      const name = String(input.name ?? input.branch ?? "")
      const path = input.path ? ` (${input.path})` : ""
      return `${name}${path}`
    }
    case "ExitWorktree":
      return String(input.name ?? input.branch ?? "")
    case "Skill":
      return String(input.skill ?? input.name ?? "")
    case "ToolSearch":
      return String(input.query ?? "")
    default: {
      const keys = Object.keys(input)
      if (keys.length === 0) return ""
      const first = input[keys[0]]
      if (typeof first !== "string") return ""
      return first.length > 80 ? first.slice(0, 80) + "..." : first
    }
  }
}
