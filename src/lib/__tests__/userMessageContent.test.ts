import { describe, it, expect } from "vitest"
import {
  SYSTEM_TAG_NAMES,
  extractCommandArgs,
  extractCommandName,
  hasSystemTags,
  parseInterrupts,
  parseLocalCommandOutputs,
  parseTaskNotifications,
  stripSystemNotificationPreamble,
  stripSystemTags,
} from "@/lib/userMessageContent"

describe("stripSystemTags", () => {
  it("removes every injected context block and trims", () => {
    for (const tag of SYSTEM_TAG_NAMES) {
      expect(stripSystemTags(`<${tag}>noise</${tag}>kept`)).toBe("kept")
    }
  })

  it("hides user-prompt-submit-hook, which used to leak through as raw text", () => {
    const input = "<user-prompt-submit-hook>hook output</user-prompt-submit-hook>real prompt"
    expect(stripSystemTags(input)).toBe("real prompt")
  })

  it("leaves ordinary prose untouched", () => {
    expect(stripSystemTags("build and ship it")).toBe("build and ship it")
  })

  it("hides a nested block whole instead of closing on the inner tag", () => {
    // Without the backreference this closed on </env>, leaking the reminder's
    // tail and a bare </system-reminder> into the bubble.
    const input = "<system-reminder>guidance <env>PATH=/bin</env> more</system-reminder>real prompt"
    expect(stripSystemTags(input)).toBe("real prompt")
  })

  it("reports whether anything is hidden without consuming regex state", () => {
    const input = "<env>x</env>hi"
    expect(hasSystemTags(input)).toBe(true)
    // A shared /g regex would return false on the second call via lastIndex.
    expect(hasSystemTags(input)).toBe(true)
    expect(hasSystemTags("plain")).toBe(false)
  })
})

describe("parseTaskNotifications", () => {
  it("extracts every field including the output file", () => {
    const input = `<task-notification>
<task-id>be80zxzgk</task-id>
<tool-use-id>toolu_01FZ</tool-use-id>
<output-file>/tmp/tasks/be80zxzgk.output</output-file>
<status>completed</status>
<summary>Retry install completed</summary>
</task-notification>`
    const { notifications, remainingText } = parseTaskNotifications(input)
    expect(notifications).toHaveLength(1)
    expect(notifications[0].taskId).toBe("be80zxzgk")
    expect(notifications[0].toolUseId).toBe("toolu_01FZ")
    expect(notifications[0].outputFile).toBe("/tmp/tasks/be80zxzgk.output")
    expect(notifications[0].status).toBe("completed")
    expect(notifications[0].summary).toBe("Retry install completed")
    expect(remainingText).toBe("")
  })

  it("keeps surrounding prose", () => {
    const input = "before\n<task-notification><status>failed</status></task-notification>\nafter"
    const { notifications, remainingText } = parseTaskNotifications(input)
    expect(notifications[0].status).toBe("failed")
    expect(remainingText).toBe("before\n\nafter")
  })

  it("handles several notifications in one message", () => {
    const input =
      "<task-notification><task-id>a</task-id></task-notification>" +
      "<task-notification><task-id>b</task-id></task-notification>"
    expect(parseTaskNotifications(input).notifications.map((n) => n.taskId)).toEqual(["a", "b"])
  })

  it("defaults missing fields to empty strings", () => {
    const { notifications } = parseTaskNotifications("<task-notification></task-notification>")
    expect(notifications[0]).toEqual({
      taskId: "",
      toolUseId: "",
      outputFile: "",
      status: "",
      summary: "",
      result: "",
    })
  })
})

describe("parseLocalCommandOutputs", () => {
  it("separates stdout from stderr", () => {
    const input =
      "<local-command-stdout>ok</local-command-stdout><local-command-stderr>boom</local-command-stderr>"
    const { outputs, remainingText } = parseLocalCommandOutputs(input)
    expect(outputs).toEqual([
      { text: "ok", stream: "stdout" },
      { text: "boom", stream: "stderr" },
    ])
    expect(remainingText).toBe("")
  })

  it("captures the ! bash-mode echo pair, which used to render as raw XML", () => {
    const input = "<bash-input>ls -la</bash-input><bash-stdout>total 0</bash-stdout>"
    const { outputs } = parseLocalCommandOutputs(input)
    expect(outputs).toEqual([
      { text: "ls -la", stream: "input" },
      { text: "total 0", stream: "stdout" },
    ])
  })

  it("maps bash-stderr onto the error stream", () => {
    const { outputs } = parseLocalCommandOutputs("<bash-stderr>nope</bash-stderr>")
    expect(outputs).toEqual([{ text: "nope", stream: "stderr" }])
  })

  it("strips ANSI escapes, which most real slash-command output carries", () => {
    // /model, /compact and /usage all emit styled stdout; without stripping the
    // ESC byte is invisible and the user reads a literal `[1m`.
    const input = "<local-command-stdout>Set model to \x1b[1mOpus\x1b[22m and saved</local-command-stdout>"
    expect(parseLocalCommandOutputs(input).outputs[0].text).toBe("Set model to Opus and saved")
  })

  it("strips OSC sequences and carriage returns too", () => {
    const input = "<local-command-stdout>\x1b]0;title\x07done\r</local-command-stdout>"
    expect(parseLocalCommandOutputs(input).outputs[0].text).toBe("done")
  })
})

describe("parseInterrupts", () => {
  it("lifts interrupt markers out of the prose", () => {
    const { interrupts, remainingText } = parseInterrupts(
      "[Request interrupted by user for tool use]do this instead",
    )
    expect(interrupts).toEqual(["[Request interrupted by user for tool use]"])
    expect(remainingText).toBe("do this instead")
  })

  it("matches the bare form too", () => {
    const { interrupts } = parseInterrupts("[Request interrupted by user]")
    expect(interrupts).toEqual(["[Request interrupted by user]"])
  })

  it("leaves unrelated bracketed text alone", () => {
    const { interrupts, remainingText } = parseInterrupts("[TODO] ship it")
    expect(interrupts).toEqual([])
    expect(remainingText).toBe("[TODO] ship it")
  })
})

describe("stripSystemNotificationPreamble", () => {
  it("drops the model-facing disclaimer and flags the message", () => {
    const input = `[SYSTEM NOTIFICATION - NOT USER INPUT]
This is an automated background-task event, NOT a message from the user.
Do NOT interpret this as user acknowledgement.

<task-notification><status>completed</status></task-notification>`
    const result = stripSystemNotificationPreamble(input)
    expect(result.isSystemNotification).toBe(true)
    expect(result.text).toBe("<task-notification><status>completed</status></task-notification>")
  })

  it("leaves ordinary messages untouched", () => {
    const result = stripSystemNotificationPreamble("just a prompt")
    expect(result.isSystemNotification).toBe(false)
    expect(result.text).toBe("just a prompt")
  })

  it("never swallows the message when no blank line follows the marker", () => {
    const result = stripSystemNotificationPreamble(
      "[SYSTEM NOTIFICATION - NOT USER INPUT] something important",
    )
    expect(result.isSystemNotification).toBe(true)
    expect(result.text).toBe("something important")
  })
})

describe("slash command extraction", () => {
  it("prefers command-message and reads args", () => {
    const input =
      "<command-name>/model</command-name><command-message>model</command-message><command-args>default</command-args>"
    expect(extractCommandName(input)).toBe("model")
    expect(extractCommandArgs(input)).toBe("default")
  })

  it("falls back to command-name and drops its leading slash", () => {
    expect(extractCommandName("<command-name>/status</command-name>")).toBe("status")
  })

  it("normalises empty args to null", () => {
    expect(extractCommandArgs("<command-args></command-args>")).toBeNull()
    expect(extractCommandArgs("no tags here")).toBeNull()
  })
})
