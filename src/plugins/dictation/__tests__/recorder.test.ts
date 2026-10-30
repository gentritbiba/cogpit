// @vitest-environment node
import { describe, expect, it } from "vitest"
import { DICTATION_SAMPLE_RATE, encodeWav, levelOf, MAX_DICTATION_SECONDS } from "../recorder"
import { MEDIA_LIMIT_BYTES } from "@cogpit/plugin-contracts"

describe("dictation recordings", () => {
  it("encodes 16-bit mono PCM WAV that clips out-of-range samples", async () => {
    const wav = encodeWav(Float32Array.from([0, 1, -1, 2, -0.5]), DICTATION_SAMPLE_RATE)
    expect(wav.type).toBe("audio/wav")
    const view = new DataView(await wav.arrayBuffer())
    const ascii = (offset: number) => String.fromCharCode(...new Uint8Array(view.buffer, offset, 4))
    expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"])
    expect({ format: view.getUint16(20, true), channels: view.getUint16(22, true), rate: view.getUint32(24, true), bits: view.getUint16(34, true), data: view.getUint32(40, true) })
      .toEqual({ format: 1, channels: 1, rate: 16000, bits: 16, data: 10 })
    expect([0, 1, 2, 3, 4].map(index => view.getInt16(44 + index * 2, true))).toEqual([0, 32767, -32768, 32767, -16384])
  })
  it("keeps the longest take inside the upload limit", () => {
    expect(44 + MAX_DICTATION_SECONDS * DICTATION_SAMPLE_RATE * 2).toBeLessThanOrEqual(MEDIA_LIMIT_BYTES)
  })
  it("maps loudness onto a 0 to 1 scale that shows quiet speech", () => {
    expect(levelOf(new Float32Array(512))).toBe(0)
    expect(levelOf(new Float32Array(512).fill(1))).toBe(1)
    const quiet = levelOf(new Float32Array(512).fill(0.02))
    expect(quiet).toBeGreaterThan(0.2)
    expect(quiet).toBeLessThan(0.6)
  })
})
