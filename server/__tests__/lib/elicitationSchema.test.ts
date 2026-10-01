// @vitest-environment node
import { describe, expect, it } from "vitest"
import { projectElicitationSchema } from "../../lib/elicitationSchema"

describe("projectElicitationSchema", () => {
  it("treats a missing schema as a bare confirm", () => {
    expect(projectElicitationSchema(undefined)).toEqual({ fields: [] })
  })

  it("projects primitive fields with their labels, defaults and required flags", () => {
    expect(projectElicitationSchema({
      type: "object",
      properties: {
        token: { type: "string", title: "API token", description: "From settings" },
        retries: { type: "integer", default: 3 },
        remember: { type: "boolean", default: true },
      },
      required: ["token"],
    })).toEqual({
      fields: [
        { name: "token", label: "API token", type: "string", required: true, description: "From settings" },
        { name: "retries", label: "retries", type: "integer", required: false, defaultValue: 3 },
        { name: "remember", label: "remember", type: "boolean", required: false, defaultValue: true },
      ],
    })
  })

  it("draws both spellings of a single choice", () => {
    expect(projectElicitationSchema({
      type: "object",
      properties: {
        legacy: { type: "string", enum: ["a", "b"], enumNames: ["Alpha"] },
        titled: {
          type: "string",
          oneOf: [{ const: "p1", title: "Urgent" }, { const: "p2" }],
          default: "p2",
        },
      },
    })).toEqual({
      fields: [
        {
          name: "legacy",
          label: "legacy",
          type: "enum",
          required: false,
          options: [{ value: "a", label: "Alpha" }, { value: "b", label: "b" }],
        },
        {
          name: "titled",
          label: "titled",
          type: "enum",
          required: false,
          options: [{ value: "p1", label: "Urgent" }, { value: "p2", label: "p2" }],
          defaultValue: "p2",
        },
      ],
    })
  })

  it.each([
    [{ type: "array" }, "the request is an array"],
    [
      { type: "object", properties: { tags: { type: "array" } } },
      '"tags" is an array, which Cogpit cannot render',
    ],
    [
      { type: "object", properties: { level: { enum: [1, 2] } } },
      '"level" is an enum of non-string values',
    ],
    [
      { type: "object", properties: { level: { oneOf: [{ const: 1, title: "One" }] } } },
      '"level" is a choice between non-string values',
    ],
    [
      { type: "object", properties: {}, required: ["ghost"] },
      'required field "ghost" has no schema',
    ],
  ])("says why %j cannot be drawn", (schema, unsupported) => {
    expect(projectElicitationSchema(schema)).toEqual({ unsupported })
  })
})
