// Terminal escape sequences leak into anything that captures a CLI's stdout —
// process output, and `<local-command-stdout>` blocks in the transcript (`/model`,
// `/compact` and `/usage` all emit styled text). Rendered as-is the ESC byte is
// invisible and the user reads literal `[1m` noise.
//
// The iOS client mirrors this in `ios/CogpitKit/Sources/CogpitKit/Transcript/UserMessageContent.swift`.

// eslint-disable-next-line no-control-regex
const ANSI_OSC = /\x1b\].*?(?:\x07|\x1b\\)/g
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1b\[[0-9;]*[A-Za-z]/g
// eslint-disable-next-line no-control-regex
const ANSI_OTHER = /\x1b[()][AB012]/g
const LINE_REDRAW = /\[2K\[1G/g

/** Removes OSC/CSI/charset escapes and carriage returns; redraws become newlines. */
export function stripAnsi(text: string): string {
  return text
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(ANSI_OTHER, "")
    .replace(LINE_REDRAW, "\n")
    .replace(/\r/g, "")
}
