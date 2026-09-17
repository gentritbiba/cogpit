import { describe, expect, it } from "vitest"
import { connectionResourceDependencies, parseConnectionDefinition, type ConnectionDefinition, type ConnectionOperation } from "../connections.js"

const op = (path: ConnectionOperation["path"], audience: "setup" | "panel" = "setup"): ConnectionOperation => ({ audience, origin: "https://api.example.test", method: "GET", path, args: {}, query: {} })
function fixture(): ConnectionDefinition {
  return {
    version: 1, id: "service", label: "Service", secret: { id: "token", label: "Token" }, auth: { header: "Authorization", scheme: "raw" },
    validationOperation: "validate", identity: { viewer: "/user/id" },
    resources: {
      account: { label: "Account", scope: "connection", options: { operation: "accounts", items: "/items", id: "/id", label: "/name" } },
      file: { label: "File", scope: "project", dependsOn: ["account"],
        options: [{ operation: "files", items: "/files", id: "/id", label: "/name" }, { operation: "folders", items: "/folders", nested: "/files", id: "/id", label: "/name" }],
        input: { allowId: true, urls: [{ origin: "https://app.example.test", pathMarker: "file" }],
          validation: { operation: "validateFile", argument: "candidate", id: "/id", label: "/name", parents: { account: "/account/id" } } } },
    },
    operations: {
      validate: op([{ literal: "me" }]), accounts: op([{ literal: "accounts" }]),
      files: op([{ resource: "account" }, { literal: "files" }]), folders: op([{ resource: "account" }, { literal: "folders" }]),
      validateFile: { ...op([{ literal: "files" }, { arg: "candidate" }]), args: { candidate: { type: "string", required: true, maxLength: 128 } } },
      read: { ...op([{ resource: "file" }, { literal: "content" }], "panel"), args: { page: { type: "integer", min: 0, max: 2 } },
        query: { "assignees[]": { identity: "viewer" }, account: { resource: "account" }, page: { arg: "page" }, archived: { literal: false } } },
    },
  }
}

describe("declarative connection resources", () => {
  it("accepts finite entered resources, multiple nested sources and host-owned query bindings", () => {
    const parsed = parseConnectionDefinition(fixture())
    expect(parsed.operations.read.query["assignees[]"]).toEqual({ identity: "viewer" })
    expect(connectionResourceDependencies(parsed, "file")).toEqual(["account"])
  })
  it("preserves old option mappings and string query arguments and infers their dependencies", () => {
    const input = fixture()
    delete input.resources.file.dependsOn
    delete input.resources.file.input
    input.resources.file.options = { operation: "files", items: "/files", id: "/id", label: "/name" }
    input.operations.read.query.page = "page"
    expect(connectionResourceDependencies(parseConnectionDefinition(input), "file")).toEqual(["account"])
  })
  it("supports a file response without an echoed resource ID", () => {
    const input = fixture()
    delete input.resources.file.input!.validation.id
    expect(() => parseConnectionDefinition(input)).not.toThrow()
  })
  it.each([
    ["self dependency", (d: ConnectionDefinition) => { d.resources.account.dependsOn = ["account"] }],
    ["indirect cycle", (d: ConnectionDefinition) => { d.operations.accounts.path = [{ resource: "file" }] }],
    ["unknown dependency", (d: ConnectionDefinition) => { d.resources.file.dependsOn = ["missing"] }],
    ["connection depends on project", (d: ConnectionDefinition) => { d.resources.account.scope = "project"; d.resources.file.scope = "connection" }],
    ["missing parent proof", (d: ConnectionDefinition) => { delete d.resources.file.input!.validation.parents }],
    ["extra parent proof", (d: ConnectionDefinition) => { d.resources.file.input!.validation.parents = { account: "/id", other: "/id" } }],
    ["unbound options", (d: ConnectionDefinition) => { d.operations.files.path = [{ literal: "all-files" }] }],
    ["candidate not requested", (d: ConnectionDefinition) => { d.operations.validateFile.path = [{ literal: "files" }] }],
    ["setup calls panel", (d: ConnectionDefinition) => { d.resources.file.input!.validation.operation = "read" }],
    ["identity supplied by caller", (d: ConnectionDefinition) => { d.operations.read.args.viewer = { type: "string", maxLength: 32 } }],
    ["unknown query identity", (d: ConnectionDefinition) => { d.operations.read.query["assignees[]"] = { identity: "other" } }],
    ["unknown query resource", (d: ConnectionDefinition) => { d.operations.read.query.account = { resource: "other" } }],
    ["recursive query syntax", (d: ConnectionDefinition) => { d.operations.read.query["a[b]"] = { literal: "x" } }],
    ["validation needs resource", (d: ConnectionDefinition) => { d.operations.validate.path = [{ resource: "account" }] }],
    ["validation needs identity", (d: ConnectionDefinition) => { d.operations.validate.query.viewer = { identity: "viewer" } }],
    ["empty input formats", (d: ConnectionDefinition) => { d.resources.file.input = { ...d.resources.file.input!, allowId: false, urls: undefined } }],
  ])("rejects %s", (_name, mutate) => {
    const input = fixture(); mutate(input)
    expect(() => parseConnectionDefinition(input)).toThrow()
  })
  it.each(["https://app.example.test/path", "http://app.example.test", "https://127.0.0.1", "https://app.example.test:443"])("rejects non-exact URL extraction origin %s", (origin) => {
    const input = fixture(); input.resources.file.input!.urls![0].origin = origin
    expect(() => parseConnectionDefinition(input)).toThrow()
  })
  it.each(["__proto__", "/files/~9"])("rejects invalid pointer %s", (pointer) => {
    const input = fixture(); input.resources.file.input!.validation.label = pointer
    expect(() => parseConnectionDefinition(input)).toThrow()
  })
  it("rejects author regexes and expressions and resource declarations without a selection mechanism", () => {
    expect(() => parseConnectionDefinition({ ...fixture(), expression: "data.files.filter(x => true)" })).toThrow()
    const input = fixture()
    input.resources.file = { label: "File" }
    expect(() => parseConnectionDefinition(input)).toThrow()
  })
})
