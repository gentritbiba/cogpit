import { describe, expect, it } from "vitest"
import { getCodexExecCalls } from "../../../shared/session/codex-exec"

describe("getCodexExecCalls", () => {
  it("returns calls in source order and ignores tool names inside strings and comments", () => {
    const calls = getCodexExecCalls({ raw: [
      '// tools.exec_command({cmd: "not a call"})',
      `const example = 'tools.view_image({path: "not a call"})';`,
      'text(await tools.exec_command({"cmd":"bun run test","workdir":"/workspace"}));',
      'text(await tools["web__run"]({"search_query":[{"q":"official docs"}]}));',
      'text(await tools.spawn_agent({"task_name":"review","message":"Review the change"}));',
    ].join("\n") })

    expect(calls).toEqual([
      { name: "exec_command", input: { cmd: "bun run test", workdir: "/workspace" } },
      { name: "web__run", input: { search_query: [{ q: "official docs" }] } },
      { name: "spawn_agent", input: { task_name: "review", message: "Review the change" } },
    ])
  })

  it("reads static fields from JavaScript object literals and retains only their argument source", () => {
    const argument = "{cmd: 'printf \\\"hello\\\\n\\\"', workdir: '/tmp/a b', yield_time_ms: 1000, tty: false}"
    const [call] = getCodexExecCalls({ raw: `const result = await tools.exec_command(${argument}); text(result);` })
    expect(call).toEqual({
      name: "exec_command",
      input: { raw: argument, cmd: 'printf "hello\\n"', workdir: "/tmp/a b", yield_time_ms: 1000, tty: false },
    })
  })

  it("uses the existing scanner to resolve directly assigned literal arguments", () => {
    const [call] = getCodexExecCalls({ raw: 'const args = {"path":"/tmp/preview.png"}; image(await tools.view_image(args));' })
    expect(call).toEqual({ name: "view_image", input: { path: "/tmp/preview.png" } })
  })

  it("does not resolve assignments from comments or quoted source examples", () => {
    const [call] = getCodexExecCalls({ raw: [
      'const request = {"cmd":"actual"};',
      '// const request = {cmd: "line comment"};',
      '/* const request = {cmd: "block comment"}; */',
      `const example = 'const request = {cmd: "quoted example"};';`,
      'text(await tools.exec_command(request));',
    ].join("\n") })
    expect(call).toEqual({ name: "exec_command", input: { cmd: "actual" } })
  })

  it("does not treat another object's tools property as the injected tools object", () => {
    expect(getCodexExecCalls({ raw: [
      'other.tools.exec_command({cmd: "foreign"});',
      'other?.tools.exec_command({cmd: "optional property"});',
      'other. /* property comment */ tools.exec_command({cmd: "comment between property"});',
      'other. // property comment',
      ' tools.exec_command({cmd: "next line property"});',
      'tools.exec_command({"cmd":"actual"});',
    ].join("\n") })).toEqual([{ name: "exec_command", input: { cmd: "actual" } }])
  })

  it("decodes string and array arguments without treating them as objects", () => {
    expect(getCodexExecCalls({ raw: [
      'tools.apply_patch("*** Begin Patch\\n*** End Patch");',
      'tools.example(["first",{"second":true}]);',
    ].join("\n") })).toEqual([
      { name: "apply_patch", input: { raw: "*** Begin Patch\n*** End Patch" } },
      { name: "example", input: { value: ["first", { second: true }] } },
    ])
  })

  it("keeps dynamic expressions and template interpolation as source without executing them", () => {
    const argument = "{cmd: 'bun ' + getScript(), workdir: `/tmp/${project}`, tty: true}"
    const [call] = getCodexExecCalls({ raw: `tools.exec_command(${argument});` })
    expect(call).toEqual({ name: "exec_command", input: { raw: argument, tty: true } })
    expect(getCodexExecCalls({ raw: "tools.example(globalThis.runUntrustedCode());" })).toEqual([
      { name: "example", input: { raw: "globalThis.runUntrustedCode()" } },
    ])
  })

  it("retains incomplete streaming input and nested non-JSON values as source", () => {
    expect(getCodexExecCalls({ raw: "tools.exec_command({cmd: 'partial" })).toEqual([
      { name: "exec_command", input: { raw: "{cmd: 'partial" } },
    ])
    expect(getCodexExecCalls({ raw: 'tools.web__run({search_query: [{q: "docs"}]});' })).toEqual([
      { name: "web__run", input: { raw: '{search_query: [{q: "docs"}]}' } },
    ])
  })

  it("returns no calls for absent or unrelated scripts", () => {
    expect(getCodexExecCalls({})).toEqual([])
    expect(getCodexExecCalls({ raw: "text('No tool calls');" })).toEqual([])
  })
})
