export const DICTATION_SAMPLE_RATE = 16_000
/** 16 kHz 16-bit WAV is 32 KB a second, so four minutes stays under the 8 MiB upload limit. */
export const MAX_DICTATION_SECONDS = 240

/** 16-bit PCM mono WAV: the one format every speech service reads without a decoder. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2))
  const ascii = (offset: number, value: string) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)) }
  ascii(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); ascii(8, "WAVE")
  ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  ascii(36, "data"); view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return new Blob([view.buffer], { type: "audio/wav" })
}

/** Loudness of one analyser window as 0 (silence) to 1, on a decibel scale so quiet speech still shows. */
export function levelOf(samples: Float32Array): number {
  let sum = 0
  for (const sample of samples) sum += sample * sample
  const decibels = 10 * Math.log10(sum / Math.max(1, samples.length) + 1e-12)
  return Math.min(1, Math.max(0, (decibels + 60) / 45))
}

async function toWav(encoded: Blob): Promise<Blob> {
  const decoded = await new OfflineAudioContext(1, 1, DICTATION_SAMPLE_RATE).decodeAudioData(await encoded.arrayBuffer())
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * DICTATION_SAMPLE_RATE)), DICTATION_SAMPLE_RATE)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  return encodeWav((await offline.startRendering()).getChannelData(0), DICTATION_SAMPLE_RATE)
}

export interface Recording {
  level(): number
  /** Turns the microphone off and resolves with the take as 16 kHz mono WAV. */
  stop(): Promise<Blob>
  /** Turns the microphone off and discards the take. */
  cancel(): void
}

export function canRecord(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function"
    && typeof MediaRecorder !== "undefined" && typeof OfflineAudioContext !== "undefined"
}

export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  const context = new AudioContext()
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  context.createMediaStreamSource(stream).connect(analyser)
  const frame = new Float32Array(analyser.fftSize)
  const recorder = new MediaRecorder(stream)
  const chunks: Blob[] = []
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
  let released = false
  const release = () => {
    if (released) return
    released = true
    for (const track of stream.getTracks()) track.stop()
    void context.close().catch(() => {})
  }
  recorder.start(1000)
  return {
    level() {
      if (released) return 0
      analyser.getFloatTimeDomainData(frame)
      return levelOf(frame)
    },
    stop() {
      return new Promise((resolve, reject) => {
        recorder.onstop = () => {
          release()
          if (!chunks.length) { reject(new Error("Nothing was recorded")); return }
          toWav(new Blob(chunks, { type: recorder.mimeType })).then(resolve, reject)
        }
        if (recorder.state === "inactive") recorder.onstop(new Event("stop"))
        else recorder.stop()
      })
    },
    cancel() {
      recorder.onstop = null
      if (recorder.state !== "inactive") recorder.stop()
      release()
    },
  }
}
