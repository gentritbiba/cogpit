import type { ITheme } from "@xterm/xterm"

export function readTerminalTheme(element: HTMLElement): ITheme {
  const styles = getComputedStyle(element)
  const color = (name: string) => styles.getPropertyValue(`--${name}`).trim()
  return {
    background: "#00000000",
    foreground: color("foreground"),
    cursor: color("foreground"),
    cursorAccent: color("canvas"),
    selectionBackground: color("terminal-selection"),
    black: color("terminal-black"), brightBlack: color("muted-foreground"),
    red: color("destructive"), brightRed: color("destructive"),
    green: color("success"), brightGreen: color("success"),
    yellow: color("warning"), brightYellow: color("warning"),
    blue: color("info"), brightBlue: color("info"),
    magenta: color("terminal-magenta"), brightMagenta: color("terminal-magenta"),
    cyan: color("terminal-cyan"), brightCyan: color("terminal-cyan"),
    white: color("terminal-white"), brightWhite: color("terminal-white"),
  }
}
