import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useImageUpload } from "../useImageUpload"

function image(id: string) {
  return {
    id,
    data: "eA==",
    mediaType: "image/png",
  }
}

describe("useImageUpload", () => {
  it("puts back the images of a refused send, unless others were attached since", () => {
    const { result } = renderHook(() => useImageUpload())

    act(() => result.current.restoreImages([image("refused")]))
    expect(result.current.images.map((img) => img.id)).toEqual(["refused"])

    act(() => result.current.restoreImages([image("older")]))
    expect(result.current.images.map((img) => img.id)).toEqual(["refused"])
  })
})

it("cancels stale upload callbacks after a draft replacement and makes read failures visible", () => {
  const readers: Array<{ onload?: () => void; onerror?: () => void; result: string; readAsDataURL: () => void }> = []
  const original = globalThis.FileReader
  class Reader {
    onload?: () => void
    onerror?: () => void
    result = "data:image/png;base64,eA=="
    readAsDataURL() {}
    constructor() { readers.push(this) }
  }
  globalThis.FileReader = Reader as unknown as typeof FileReader
  try {
    const { result } = renderHook(() => useImageUpload())
    const drop = () => result.current.handleDrop({ preventDefault() {}, dataTransfer: { files: [new File(["x"], "capture.png", { type: "image/png" })] } } as unknown as React.DragEvent)
    act(drop)
    expect(result.current.uploading).toBe(true)
    act(() => { result.current.clearImages(); readers[0].onload?.() })
    expect(result.current.images).toEqual([])
    expect(result.current.uploading).toBe(false)
    act(drop)
    act(() => readers[1].onerror?.())
    expect(result.current.imageError).toMatch(/Could not read capture.png/)
    expect(result.current.uploading).toBe(false)
  } finally { globalThis.FileReader = original }
})
