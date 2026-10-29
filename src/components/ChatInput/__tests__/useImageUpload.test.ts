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
