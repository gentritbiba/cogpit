import { describe, expect, it } from "vitest"
import {
  extractApplyPatchInputs as facadeExtractApplyPatchInputs,
  findFailedNestedPatchCallIds as facadeFindFailedNestedPatchCallIds,
  parseApplyPatch as facadeParseApplyPatch,
  parseCodexToolPatches as facadeParseCodexToolPatches,
} from "../codex"
import * as patches from "../../../shared/session/codex-patches"
import type { ToolCall } from "../types"

const ADD_PATCH = [
  "*** Begin Patch",
  "*** Add File: src/new.ts",
  "+export const value = 1",
  "*** End Patch",
].join("\n")

describe("Codex patch module facade", () => {
  it("preserves exported function identity through the compatibility facade", () => {
    expect(facadeExtractApplyPatchInputs).toBe(patches.extractApplyPatchInputs)
    expect(facadeFindFailedNestedPatchCallIds).toBe(patches.findFailedNestedPatchCallIds)
    expect(facadeParseApplyPatch).toBe(patches.parseApplyPatch)
    expect(facadeParseCodexToolPatches).toBe(patches.parseCodexToolPatches)
  })

  it("returns identical direct-module and facade results", () => {
    expect(facadeParseApplyPatch(ADD_PATCH, "call", "timestamp", "/workspace"))
      .toEqual(patches.parseApplyPatch(ADD_PATCH, "call", "timestamp", "/workspace"))
  })
})

describe("extractApplyPatchInputs boundaries", () => {
  it("decodes escaped quote forms and deduplicates the same patch payload", () => {
    const encoded = JSON.stringify(ADD_PATCH)
    const source = [
      `const patch = ${encoded};`,
      "await tools.apply_patch(patch);",
      `await tools . apply_patch ( ${encoded} );`,
    ].join("\n")

    expect(patches.extractApplyPatchInputs(source)).toEqual([ADD_PATCH])
  })

  it("decodes hexadecimal, unicode, and line-continuation escapes", () => {
    const source = String.raw`await tools.apply_patch("*** Begin Patch\n*** Add File: \x61\u002e\u{74}\
s\n+x\n*** End Patch")`

    expect(patches.extractApplyPatchInputs(source)).toEqual([
      "*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch",
    ])
  })

  it("tolerates unknown escapes and CRLF line continuations like JavaScript strings", () => {
    const source = "await tools.apply_patch(\"*** Begin Patch\\n*** Add File: a\\q\\\r\n.ts\\n+x\\n*** End Patch\")"

    expect(patches.extractApplyPatchInputs(source)).toEqual([
      "*** Begin Patch\n*** Add File: aq.ts\n+x\n*** End Patch",
    ])
  })

  it("rejects a literal ending in a dangling escape", () => {
    expect(patches.extractApplyPatchInputs("tools.apply_patch(\"*** Begin Patch*** End Patch\\"))
      .toEqual([])
  })

  it("rejects unterminated, indirect, and non-tools calls", () => {
    const unterminated = `await tools.apply_patch("${ADD_PATCH}`
    const indirect = `const patch = ${JSON.stringify(ADD_PATCH)};\nrun(patch)`
    const nonToolsCall = `apply_patch(${JSON.stringify(ADD_PATCH)})`

    expect(patches.extractApplyPatchInputs(unterminated)).toEqual([])
    expect(patches.extractApplyPatchInputs(indirect)).toEqual([])
    expect(patches.extractApplyPatchInputs(nonToolsCall)).toEqual([])
  })

  it("rejects patch-looking literals missing either boundary marker", () => {
    expect(patches.extractApplyPatchInputs("await tools.apply_patch('*** Begin Patch')")).toEqual([])
    expect(patches.extractApplyPatchInputs("await tools.apply_patch('*** End Patch')")).toEqual([])
  })
})

describe("parseApplyPatch boundaries", () => {
  it("normalizes relative paths but preserves Unix and Windows absolute paths", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: ./relative.ts",
      "+relative",
      "*** Add File: /absolute.ts",
      "+unix",
      "*** Add File: C:\\absolute.ts",
      "+windows",
      "*** End Patch",
    ].join("\n")

    expect(patches.parseApplyPatch(patch, "call", "ts", "/workspace/").map((call) => call.input.file_path))
      .toEqual(["/workspace/relative.ts", "/absolute.ts", "C:\\absolute.ts"])
  })

  it("normalizes delete sections into empty Edit replacements", () => {
    const patch = [
      "*** Begin Patch",
      "*** Delete File: old.ts",
      "@@",
      "-old content",
      "*** End Patch",
    ].join("\n")

    expect(patches.parseApplyPatch(patch, "delete", "ts", "/workspace")).toEqual([{
      id: "delete",
      name: "Edit",
      input: {
        file_path: "/workspace/old.ts",
        old_string: "old content",
        new_string: "",
      },
      result: null,
      isError: false,
      timestamp: "ts",
    }])
  })

  it("normalizes update context into both sides of an Edit call", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: source.ts",
      "@@",
      " shared context",
      "-before",
      "+after",
      "*** End Patch",
    ].join("\n")

    expect(patches.parseApplyPatch(patch, "update", "ts", "/workspace")[0]).toMatchObject({
      id: "update",
      name: "Edit",
      input: {
        file_path: "/workspace/source.ts",
        old_string: "shared context\nbefore",
        new_string: "shared context\nafter",
      },
    })
  })

  it("returns no tool calls for malformed or unsupported section headers", () => {
    expect(patches.parseApplyPatch("*** Begin Patch\n*** Rename File: a.ts\n*** End Patch", "call", "ts"))
      .toEqual([])
    expect(patches.parseApplyPatch("not a patch", "call", "ts")).toEqual([])
  })
})

describe("parseCodexToolPatches", () => {
  it("delegates direct patches without changing the parent call ID", () => {
    expect(patches.parseCodexToolPatches("apply_patch", ADD_PATCH, "direct", "ts", "/workspace"))
      .toEqual(patches.parseApplyPatch(ADD_PATCH, "direct", "ts", "/workspace"))
  })

  it("assigns stable nested patch IDs to exec-wrapper payloads", () => {
    const source = `await tools.apply_patch(${JSON.stringify(ADD_PATCH)})`
    expect(patches.parseCodexToolPatches("exec", source, "wrapper", "ts", "/workspace")[0].id)
      .toBe("wrapper:patch-0")
  })
})

describe("nested patch failure attribution", () => {
  const calls: ToolCall[] = [
    {
      id: "exec:patch-0",
      name: "Write",
      input: { file_path: "/workspace/a.ts", content: "a" },
      result: null,
      isError: false,
      timestamp: "ts",
    },
    {
      id: "exec:patch-1:file-0",
      name: "Edit",
      input: { file_path: "/workspace/src/b.ts", old_string: "b", new_string: "B" },
      result: null,
      isError: false,
      timestamp: "ts",
    },
    {
      id: "exec:patch-2",
      name: "Write",
      input: { file_path: "/workspace/c.ts", content: "c" },
      result: null,
      isError: false,
      timestamp: "ts",
    },
  ]

  it("does not taint calls for successful wrappers or unrelated failures", () => {
    expect([...patches.findFailedNestedPatchCallIds("invalid patch", false, calls)]).toEqual([])
    expect([...patches.findFailedNestedPatchCallIds("network error", true, calls)]).toEqual([])
  })

  it("marks the identified patch group and all later sequential calls", () => {
    expect([
      ...patches.findFailedNestedPatchCallIds("apply_patch failed for src/b.ts", true, calls),
    ]).toEqual(["exec:patch-1:file-0", "exec:patch-2"])
  })

  it("falls back to the final group when an aggregate patch error has no identifier", () => {
    expect([...patches.findFailedNestedPatchCallIds("apply_patch failed", true, calls)])
      .toEqual(["exec:patch-2"])
  })

  it("accepts an explicit nested patch index when no path is available", () => {
    const callsWithoutPaths = calls.map((call) => ({ ...call, input: {} }))
    expect([...patches.findFailedNestedPatchCallIds("invalid patch #1", true, callsWithoutPaths)])
      .toEqual(["exec:patch-1:file-0", "exec:patch-2"])
  })

  it("marks every call when IDs do not contain nested patch indices", () => {
    const directCalls = calls.map((call, index) => ({ ...call, id: `direct-${index}` }))
    expect([...patches.findFailedNestedPatchCallIds("invalid patch", true, directCalls)])
      .toEqual(["direct-0", "direct-1", "direct-2"])
  })
})
