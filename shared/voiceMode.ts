/** Hidden by both transcript renderers (src/lib/userMessageContent.ts, iOS UserMessageContent.swift). */
export const VOICE_MODE_TAG = "cogpit-voice-mode"

const INSTRUCTION = `The user is talking to you from Cogpit voice mode: they are listening hands-free and may not see the screen.
End every reply with what you would say to them aloud, in this fenced block:

\`\`\`cogpit:cogpit.tts:speech
The words to speak go here.
\`\`\`

Use it to announce what you did or found, briefly and in plain spoken prose with no lists, code, paths or URLs. When you need an answer or a decision from the user, ask it inside that block and end your turn instead of using a question tool, so they can answer by voice.`

/** A voice-mode message carries the speaking rule with it, so it holds for every agent without changing the session's instructions. */
export function withVoiceModeInstruction(message: string): string {
  return `${message}\n\n<${VOICE_MODE_TAG}>\n${INSTRUCTION}\n</${VOICE_MODE_TAG}>`
}
