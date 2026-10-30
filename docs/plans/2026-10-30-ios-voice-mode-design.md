# iOS voice mode

Hands-free conversation with one session from the iPhone app. Phase 1 of a path
toward a CarPlay voice app (iOS 26.4 "voice-based conversational" category).

## Experience

A waveform button in the session toolbar opens a full-screen voice view for that
session. The loop: listen → send → the agent works → speak its reply → listen.

- The screen shows the phase (Listening / Working / Speaking), a live caption of
  the user's speech and the last thing the agent said.
- Controls: mute microphone, skip/interrupt speech, end. These match the CarPlay
  voice template, so a later CarPlay scene reuses the same model.
- A pending tool permission is read aloud ("wants to run Bash, allow or deny?")
  and answered by voice or button.
- The screen stays awake while voice mode is open. Background and lock-screen use
  are out of scope.
- `cogpit:cogpit.tts:speech` fences in the transcript render as speech cards with a
  play button, matching the desktop plugin card.

## Agents speak through the speech skill

Voice mode sends with `voice: true` on `POST /api/send-message`. The server appends
a tagged instruction to that message telling the agent the user is listening
hands-free: announce results and ask questions inside a `cogpit:cogpit.tts:speech`
block instead of a question tool. The server owns the wording. Desktop and iOS
transcripts hide the tag.

The phone speaks each speech block as soon as the message containing it is final,
so mid-turn announcements are heard. A reply with no speech block produces a short
"Done, check the screen."

Desktop sessions are unchanged: the rule applies only to voice-mode messages.

## Voice and speech recognition

- **Voice:** `POST /api/voice/speech {text}` returns audio synthesized through the
  Text to speech plugin's connection, selected voice and speed. When the plugin is
  not configured or the call fails, the phone uses the device voice.
- **Recognition, phase 1:** Apple on-device recognition provides captions,
  end-of-speech detection and the text.
- **Recognition, phase 2:** the recording is uploaded to our Whisper service through
  the plugin's `transcribe` dictation operation for the final text, with Apple's
  text as the fallback. Needs the in-progress plugin dictation work.

## Components

Server (this repository):

- `server/routes/voice.ts`: `/api/voice/speech`, registered in `server/api-routes.ts`
  and listed in the team edition's route policy.
- `PluginManager`: a lease-free media call for core routes, beside `withLegacyPlugin`.
- `session-send`: the `voice` flag and the tagged instruction.
- Transcript parsing hides the voice tag on desktop.

iOS (`ios/`, separate repository):

- `CogpitKit/Voice/`: `VoiceModeModel` (the loop, behind recognizer, speaker and
  session seams), `SpeechPlayback` (transcript speech cards), speech-fence
  extraction, the speech endpoint client.
- `CogpitUI/Features/Voice/`: the voice screen, the speech card, the toolbar
  launcher.
- `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription` in
  `App/Info.plist` and `project.yml`.

## Error handling

- Microphone or recognition permission denied: the screen says so and links to
  Settings.
- Speech route unavailable: fall back to the device voice for the rest of the
  session.
- Send failure: one line on screen, the utterance stays available to resend.
- Copilot sessions have no turn-end signal; their turn ends after the 30 s
  inactivity timeout.

## Testing

- Vitest: speech route (configured, not configured, plugin disabled, upstream
  failure), the `voice` send flag, tag hiding.
- CogpitKitChecks: the voice loop state machine with stub seams, speech-fence
  extraction, the endpoint client.
- UI harness for the voice screen states; live QA in the simulator against a local
  server.
