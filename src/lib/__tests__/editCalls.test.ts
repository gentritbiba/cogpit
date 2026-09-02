import { describe, it, expect } from "vitest"
import {
  expandEditToolCalls,
  bashEdits,
  hasEditToolCalls,
  isSynthesized,
} from "../../../shared/session/edit-calls"
import type { ToolCall } from "../../../shared/session/types"

function call(name: string, input: Record<string, unknown>, over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "tc1",
    name,
    input,
    result: null,
    isError: false,
    timestamp: "2026-08-21T00:00:00Z",
    ...over,
  }
}

const bash = (command: string) => call("Bash", { command })

describe("expandEditToolCalls", () => {
  it("passes Edit and Write through untouched", () => {
    const edit = call("Edit", { file_path: "/a.ts", old_string: "x", new_string: "y" })
    const write = call("Write", { file_path: "/b.ts", content: "hi" })
    expect(expandEditToolCalls([edit, write])).toEqual([edit, write])
  })

  it("drops errored calls", () => {
    const edit = call("Edit", { file_path: "/a.ts", old_string: "x", new_string: "y" }, { isError: true })
    expect(expandEditToolCalls([edit])).toEqual([])
  })

  it("ignores unrelated tools", () => {
    expect(expandEditToolCalls([call("Read", { file_path: "/a.ts" })])).toEqual([])
  })
})

describe("MultiEdit expansion", () => {
  it("becomes one Edit per entry, all on the same file", () => {
    const out = expandEditToolCalls([call("MultiEdit", {
      file_path: "/a.ts",
      edits: [
        { old_string: "one", new_string: "1" },
        { old_string: "two", new_string: "2", replace_all: true },
      ],
    })])

    expect(out).toHaveLength(2)
    expect(out.every((tc) => tc.name === "Edit")).toBe(true)
    expect(out.every((tc) => tc.input.file_path === "/a.ts")).toBe(true)
    expect(out.map((tc) => [tc.input.old_string, tc.input.new_string, tc.input.replace_all])).toEqual([
      ["one", "1", false],
      ["two", "2", true],
    ])
    expect(out.map((tc) => tc.id)).toEqual(["tc1:edit-0", "tc1:edit-1"])
  })

  it("skips malformed entries rather than inventing content", () => {
    const out = expandEditToolCalls([call("MultiEdit", {
      file_path: "/a.ts",
      edits: [{ old_string: "ok", new_string: "fine" }, { old_string: 42 }, null],
    })])
    expect(out).toHaveLength(1)
  })

  it("needs a file path", () => {
    expect(expandEditToolCalls([call("MultiEdit", {
      edits: [{ old_string: "a", new_string: "b" }],
    })])).toEqual([])
  })
})

describe("apply_patch expansion", () => {
  it("normalizes raw Copilot patch arguments", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/app.ts",
      "@@",
      "-const value = 1",
      "+const value = 2",
      "*** End Patch",
    ].join("\n")

    const out = expandEditToolCalls([call("apply_patch", { value: patch })], "/workspace")

    expect(out).toEqual([
      expect.objectContaining({
        id: "tc1",
        name: "Edit",
        input: expect.objectContaining({
          file_path: "/workspace/src/app.ts",
          old_string: "const value = 1",
          new_string: "const value = 2",
          synthesizedFrom: "apply_patch",
        }),
      }),
    ])
    expect(hasEditToolCalls([call("apply_patch", { value: patch })], "/workspace")).toBe(true)
  })
})

describe("Bash heredoc writes", () => {
  it("recovers content from cat > path <<'EOF'", () => {
    const out = bashEdits(bash("cat > /tmp/x.html <<'HTML'\n<p>hi</p>\nline two\nHTML"))
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe("Write")
    expect(out[0].input.file_path).toBe("/tmp/x.html")
    expect(out[0].input.content).toBe("<p>hi</p>\nline two")
  })

  it("handles tee and quoted paths", () => {
    expect(bashEdits(bash("tee '/tmp/a b.txt' <<'EOF'\nbody\nEOF"))[0].input.file_path)
      .toBe("/tmp/a b.txt")
    expect(bashEdits(bash('cat > "/tmp/c d.txt" <<\'EOF\'\nbody\nEOF'))[0].input.file_path)
      .toBe("/tmp/c d.txt")
  })

  it("preserves an empty body", () => {
    expect(bashEdits(bash("cat > /tmp/empty <<'EOF'\nEOF"))[0].input.content).toBe("")
  })

  it("refuses unquoted delimiters, which the shell would expand", () => {
    expect(bashEdits(bash("cat > /tmp/x <<EOF\nvalue is $HOME\nEOF"))).toEqual([])
  })

  it("refuses appends, where the prior content is unknown", () => {
    expect(bashEdits(bash("cat >> /tmp/x <<'EOF'\nmore\nEOF"))).toEqual([])
    expect(bashEdits(bash("tee -a /tmp/x <<'EOF'\nmore\nEOF"))).toEqual([])
  })

  it("refuses a heredoc piped into an interpreter", () => {
    const python = "python3 - <<'EOF'\nopen('/tmp/x','w').write('hi')\nEOF"
    expect(bashEdits(bash(python))).toEqual([])
  })

  it("refuses an unterminated heredoc", () => {
    expect(bashEdits(bash("cat > /tmp/x <<'EOF'\nbody"))).toEqual([])
  })
})

describe("Bash sed edits", () => {
  it("recovers a literal substitution", () => {
    const out = bashEdits(bash("sed -i '' 's/old/new/g' /tmp/a.ts"))
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe("Edit")
    expect(out[0].input).toMatchObject({
      file_path: "/tmp/a.ts",
      old_string: "old",
      new_string: "new",
      replace_all: true,
    })
  })

  it("treats a missing g flag as a single replacement", () => {
    expect(bashEdits(bash("sed -i 's/a/b/' /tmp/a.ts"))[0].input.replace_all).toBe(false)
  })

  it("accepts alternate delimiters and a backup suffix", () => {
    expect(bashEdits(bash("sed -i.bak 's|x|y|' /tmp/a.ts"))[0].input).toMatchObject({
      old_string: "x",
      new_string: "y",
    })
  })

  it("refuses patterns that are real regexes", () => {
    expect(bashEdits(bash("sed -i '' 's/^foo.*/bar/' /tmp/a.ts"))).toEqual([])
    expect(bashEdits(bash("sed -i '' 's/a\\|b/c/' /tmp/a.ts"))).toEqual([])
  })

  it("unescapes escaped metacharacters, which are plain text", () => {
    // The commonest real shape: a dotted identifier with escaped dots.
    expect(bashEdits(bash("sed -i '' 's/history\\.toolUseID/history.request.toolUseID/g' /tmp/a.ts"))[0].input)
      .toMatchObject({ old_string: "history.toolUseID", new_string: "history.request.toolUseID" })
  })

  it("refuses escapes that carry their own meaning", () => {
    expect(bashEdits(bash("sed -i '' 's/a\\nb/c/' /tmp/a.ts"))).toEqual([])
    expect(bashEdits(bash("sed -i '' 's/\\w/c/' /tmp/a.ts"))).toEqual([])
  })

  it("refuses replacements that reference the match", () => {
    expect(bashEdits(bash("sed -i '' 's/foo/[&]/' /tmp/a.ts"))).toEqual([])
    expect(bashEdits(bash("sed -i '' 's/foo/\\1x/' /tmp/a.ts"))).toEqual([])
  })

  it("refuses an empty pattern, which matches nothing useful", () => {
    expect(bashEdits(bash("sed -i '' 's//x/' /tmp/a.ts"))).toEqual([])
  })

  it("ignores sed without -i, which writes nothing", () => {
    expect(bashEdits(bash("sed 's/a/b/' /tmp/a.ts"))).toEqual([])
  })
})

describe("ordinary Bash is left alone", () => {
  it.each([
    "grep -rn 'z-20' src/",
    "bun run test",
    "git commit -m 'fix: thing'",
    "ls -la > /dev/null",
  ])("%s", (cmd) => {
    expect(bashEdits(bash(cmd))).toEqual([])
  })

  it("tolerates a Bash call with no command", () => {
    expect(bashEdits(call("Bash", {}))).toEqual([])
  })
})

describe("compound commands", () => {
  const CWD = "/Users/me/proj"

  it("finds a write after cd && , the commonest bypass-mode shape", () => {
    const out = bashEdits(bash("cd \"/Users/me/proj\" && cat > ./notes.md <<'EOF'\nhello\nEOF"))
    expect(out).toHaveLength(1)
    expect(out[0].input.file_path).toBe("/Users/me/proj/notes.md")
    expect(out[0].input.content).toBe("hello")
  })

  it("finds a sed that is not the whole command", () => {
    const out = bashEdits(bash("cd /tmp && sed -i '' 's/a/b/' x.ts && bun run test"), CWD)
    expect(out).toHaveLength(1)
    expect(out[0].input.file_path).toBe("/tmp/x.ts")
  })

  it("recovers every heredoc in one command, not just the first", () => {
    const out = bashEdits(bash(
      "cat > /tmp/a.txt <<'A'\nfirst\nA\ncat > /tmp/b.txt <<'B'\nsecond\nB",
    ))
    expect(out.map((tc) => [tc.input.file_path, tc.input.content])).toEqual([
      ["/tmp/a.txt", "first"],
      ["/tmp/b.txt", "second"],
    ])
  })

  it("gives each synthesized call a distinct id", () => {
    const out = bashEdits(bash("cat > /tmp/a <<'A'\n1\nA\ncat > /tmp/b <<'B'\n2\nB"))
    expect(new Set(out.map((tc) => tc.id)).size).toBe(2)
  })

  it("ignores shell operators inside a heredoc body", () => {
    const out = bashEdits(bash("cat > /tmp/a.sh <<'EOF'\nfoo && bar | baz; qux\nEOF"))
    expect(out).toHaveLength(1)
    expect(out[0].input.content).toBe("foo && bar | baz; qux")
  })

  it("tracks cd across segments", () => {
    const out = bashEdits(bash("cd /tmp && cd sub && sed -i '' 's/a/b/' f.ts"))
    expect(out[0].input.file_path).toBe("/tmp/sub/f.ts")
  })

  it("collapses .. so one file cannot occupy two rows", () => {
    const out = bashEdits(bash("sed -i '' 's/a/b/' ../src/App.tsx"), "/Users/me/proj/tests")
    expect(out[0].input.file_path).toBe("/Users/me/proj/src/App.tsx")
  })
})

describe("refusals that prevent fabricated diffs", () => {
  it("refuses a heredoc piped into a program, whose output goes elsewhere", () => {
    // /tmp/out.txt receives python's stdout, never the heredoc body.
    expect(bashEdits(bash("cat <<'EOF' | python3 > /tmp/out.txt\nprint(1)\nEOF"))).toEqual([])
  })

  it("refuses a relative path with no cwd to anchor it", () => {
    expect(bashEdits(bash("sed -i '' 's/a/b/' src/App.tsx"))).toEqual([])
    expect(bashEdits(bash("cat > notes.md <<'EOF'\nhi\nEOF"))).toEqual([])
  })

  it("refuses paths carrying unexpanded shell syntax", () => {
    expect(bashEdits(bash("cat > \"$OUT/x.md\" <<'EOF'\nhi\nEOF"), "/tmp")).toEqual([])
    expect(bashEdits(bash("sed -i '' 's/a/b/' src/*.ts"), "/tmp")).toEqual([])
    expect(bashEdits(bash("cat > ~/x.md <<'EOF'\nhi\nEOF"), "/tmp")).toEqual([])
  })

  it("refuses case-insensitive sed, where the pattern need not appear verbatim", () => {
    expect(bashEdits(bash("sed -i '' 's/foo/bar/I' /tmp/a.ts"))).toEqual([])
    expect(bashEdits(bash("sed -i '' 's/foo/bar/gi' /tmp/a.ts"))).toEqual([])
  })
})

describe("hasEditToolCalls", () => {
  it("agrees with expandEditToolCalls", () => {
    const cases: ToolCall[][] = [
      [call("Edit", { file_path: "/a.ts", old_string: "x", new_string: "y" })],
      [call("Read", { file_path: "/a.ts" })],
      [bash("grep -rn foo src/")],
      [bash("cat > /tmp/x <<'EOF'\nhi\nEOF")],
      [call("Edit", { file_path: "/a.ts" }, { isError: true })],
      [],
    ]
    for (const tcs of cases) {
      expect(hasEditToolCalls(tcs)).toBe(expandEditToolCalls(tcs).length > 0)
    }
  })
})

describe("provenance", () => {
  it("marks synthesized calls and leaves real ones unmarked", () => {
    const real = call("Edit", { file_path: "/a.ts", old_string: "x", new_string: "y" })
    expect(isSynthesized(real)).toBe(false)

    const [fromBash] = bashEdits(bash("cat > /tmp/x <<'EOF'\nhi\nEOF"))
    expect(isSynthesized(fromBash)).toBe(true)
    expect(fromBash.input.synthesizedFrom).toBe("Bash")

    const [fromMulti] = expandEditToolCalls([call("MultiEdit", {
      file_path: "/a.ts",
      edits: [{ old_string: "a", new_string: "b" }],
    })])
    expect(fromMulti.input.synthesizedFrom).toBe("MultiEdit")
  })
})
